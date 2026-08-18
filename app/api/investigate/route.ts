import { NextRequest, NextResponse } from "next/server";

import { AuditIntegrityError, AuditStorageUnavailableError } from "@/lib/server/audit-storage";
import { getMemoryStore, MemoryStoreUnavailableError, OrphanedAuditArtifactError } from "@/lib/server/memory-store";
import { runInvestigationFlow } from "@/lib/server/investigation-flow";
import { prepareInvestigationRequest } from "@/lib/server/sherlock-engine";
import { getEvidenceScoutCandidateStore, resolveAcceptedCandidatesForFollowUp, type ResolvedAcceptedCandidate } from "@/lib/server/evidence-scout-store";

/**
 * Maps a failure from getMemoryStore()/runInvestigationFlow() to a clear,
 * operational API error. Distinguishes audit-storage failures from
 * CockroachDB failures and from OpenAI failures — never lumps an S3 problem
 * under "OpenAI client is unavailable". An orphaned artifact (S3 succeeded,
 * CockroachDB failed afterward) is reported distinctly so it can be
 * reconciled, never as silent success and never conflated with a normal
 * operational failure.
 */
function auditOrMemoryErrorResponse(error: unknown): Response | null {
  if (error instanceof MemoryStoreUnavailableError) return NextResponse.json({ error: "CockroachDB memory store is unavailable" }, { status: 503 });
  if (error instanceof OrphanedAuditArtifactError) {
    return NextResponse.json(
      { error: "The investigation was not persisted after its audit artifact was already written; reconciliation is required.", artifact_key: error.artifactKey, artifact_sha256: error.artifactSha256 },
      { status: 500 },
    );
  }
  if (error instanceof AuditIntegrityError) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error instanceof AuditStorageUnavailableError) return NextResponse.json({ error: "Audit artifact storage is unavailable" }, { status: 503 });
  return null;
}

export { OPENAI_MODEL } from "@/lib/server/sherlock-engine";

interface ContinueFromMemoryRequest {
  case_id: string;
  continue_from_memory: true;
  new_evidence: unknown;
}

function isContinueFromMemoryRequest(value: unknown): value is ContinueFromMemoryRequest {
  if (value === null || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return body.continue_from_memory === true && typeof body.case_id === "string";
}

function isValidAcceptedCandidateIds(value: unknown): value is string[] {
  return value === undefined || (Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim().length > 0));
}

export async function POST(req: NextRequest) {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  let memoryStore;
  try {
    memoryStore = getMemoryStore();
  } catch (error) {
    const response = auditOrMemoryErrorResponse(error);
    if (response) return response;
    if (error instanceof Error) return NextResponse.json({ error: error.message }, { status: 503 });
    throw error;
  }

  // Generic, opt-in continuation: works for any case_id, not just a specific
  // one. Existing baseline requests (Case B, Cloudflare, Google SecOps eval
  // scripts) never set continue_from_memory, so they are never silently
  // turned into a continuation even if a prior snapshot for the same
  // case_id exists.
  if (isContinueFromMemoryRequest(body)) {
    let priorSnapshot;
    try {
      priorSnapshot = await memoryStore.findLatestForCase(body.case_id);
    } catch (error) {
      if (error instanceof MemoryStoreUnavailableError) return NextResponse.json({ error: "CockroachDB memory store is unavailable" }, { status: 503 });
      throw error;
    }
    if (!priorSnapshot) {
      return NextResponse.json({ error: `No prior investigation found in memory for case_id "${body.case_id}" to continue from.` }, { status: 404 });
    }
    body = { previous_snapshot: priorSnapshot.snapshot, new_evidence: body.new_evidence };
  }

  // Point 7: the follow-up wire request only ever carries
  // accepted_candidate_ids (opaque UUID references), never provenance
  // content. Every field of the resulting EvidenceItem is resolved
  // server-side from durable evidence_scout_candidate rows before
  // prepareInvestigationRequest ever runs.
  const acceptedCandidateIdsRaw = body !== null && typeof body === "object" ? (body as Record<string, unknown>).accepted_candidate_ids : undefined;
  if (!isValidAcceptedCandidateIds(acceptedCandidateIdsRaw)) {
    return NextResponse.json({ error: "accepted_candidate_ids must be an array of non-empty strings when supplied" }, { status: 400 });
  }
  const acceptedCandidateIds = acceptedCandidateIdsRaw ?? [];
  let resolvedCandidateEvidence: ResolvedAcceptedCandidate[] = [];
  if (acceptedCandidateIds.length > 0) {
    const caseId = body !== null && typeof body === "object" && typeof (body as Record<string, unknown>).case_id === "string"
      ? (body as Record<string, unknown>).case_id as string
      : (body as { previous_snapshot?: { meta?: { case_id?: string } } })?.previous_snapshot?.meta?.case_id;
    if (!caseId) return NextResponse.json({ error: "accepted_candidate_ids requires a resolvable case_id" }, { status: 400 });
    const resolution = await resolveAcceptedCandidatesForFollowUp(getEvidenceScoutCandidateStore(), caseId, acceptedCandidateIds);
    if (!resolution.ok) return NextResponse.json({ error: resolution.message }, { status: 400 });
    resolvedCandidateEvidence = resolution.resolved;
  }

  const prepared = prepareInvestigationRequest(body, resolvedCandidateEvidence);
  if (!prepared.ok) {
    return NextResponse.json(
      { error: prepared.message },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await runInvestigationFlow(prepared.request, memoryStore, undefined, prepared.candidateLinks);
  } catch (error) {
    const response = auditOrMemoryErrorResponse(error);
    if (response) return response;
    return NextResponse.json({ error: "OpenAI client is unavailable" }, { status: 502 });
  }

  if (result.ok) {
    return NextResponse.json({
      investigation: result.investigation,
      precedents: result.precedents,
      unclassified_memory: result.unclassifiedMemory,
      suspected_duplicate_memory: result.suspectedDuplicateMemory,
      storage: result.storage,
      memory_is_lead_not_evidence: true,
      memory: result.memory,
    });
  }

  if (result.kind === "openai") {
    return NextResponse.json({ error: "OpenAI request failed" }, { status: 502 });
  }

  return NextResponse.json(
    {
      error: "Model response did not conform to the investigation schema",
      validation_errors: result.validationErrors,
    },
    { status: 502 },
  );
}
