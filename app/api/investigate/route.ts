import { NextRequest, NextResponse } from "next/server";

import { getMemoryStore, MemoryStoreUnavailableError } from "@/lib/server/memory-store";
import { runInvestigationFlow } from "@/lib/server/investigation-flow";
import { prepareInvestigationRequest } from "@/lib/server/sherlock-engine";
import { isEvidenceScoutCaseRequest, scoutCase } from "@/lib/server/evidence-scout";

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
    if (error instanceof MemoryStoreUnavailableError) return NextResponse.json({ error: "CockroachDB memory store is unavailable" }, { status: 503 });
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

  let scout;
  if (isEvidenceScoutCaseRequest(body)) {
    try { const output = await scoutCase(body); scout = output.scout; body = output.request; } catch { return NextResponse.json({ error: "Unknown Evidence Scout case; no observations were invented" }, { status: 400 }); }
  }
  const prepared = prepareInvestigationRequest(body);
  if (!prepared.ok) {
    return NextResponse.json(
      { error: prepared.message },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await runInvestigationFlow(prepared.request, memoryStore, undefined, scout);
  } catch (error) {
    if (error instanceof MemoryStoreUnavailableError) return NextResponse.json({ error: "CockroachDB memory store is unavailable" }, { status: 503 });
    return NextResponse.json({ error: "OpenAI client is unavailable" }, { status: 502 });
  }

  if (result.ok) {
    return NextResponse.json({
      investigation: result.investigation,
      precedents: result.precedents,
      unclassified_memory: result.unclassifiedMemory,
      suspected_duplicate_memory: result.suspectedDuplicateMemory,
      evidence_scout: scout ?? null,
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
