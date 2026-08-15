import { createHash } from "node:crypto";

import { canonicalize } from "@/lib/server/v2-snapshot-store";
import type { RelatedPrecedentView, SuspectedDuplicateView, UnclassifiedLegacyMemoryView } from "@/lib/investigation-response";
import type { SherlockInvestigation } from "@/types/sherlock";

/** Bumped only on a breaking change to the envelope shape below; a new optional field does not require a bump. */
export const AUDIT_ARTIFACT_SCHEMA_VERSION = "1.0.0";

export interface RetrievedMemoryForAudit {
  related: RelatedPrecedentView[];
  longitudinal: RelatedPrecedentView[];
  suspectedDuplicates: SuspectedDuplicateView[];
  unclassified: UnclassifiedLegacyMemoryView[];
}

/**
 * The canonical, versioned audit envelope. Contains only what is needed to
 * reconstruct the decision: case identity, lineage, the exact case content
 * the model reasoned over (caseEnvelope — the server-owned boundary from
 * sherlock-engine.ts's applyCanonicalCaseEnvelope), the memory retrieved and
 * how it was classified, and the full validated investigation. Deliberately
 * excludes anything environment- or transport-specific: no env vars,
 * credentials, headers, connection strings, AWS account/bucket identifiers,
 * or raw embedding vectors. createdAt is stamped by the server at build
 * time, never accepted from a caller.
 */
export interface AuditArtifactEnvelope {
  schema_version: string;
  case_id: string;
  investigation_id: string;
  snapshot_id: string;
  parent_snapshot_id: string | null;
  iteration: number;
  model_version: string;
  prompt_version: string;
  case_envelope: { meta: SherlockInvestigation["meta"]; case: SherlockInvestigation["case"] };
  retrieved_memory: RetrievedMemoryForAudit;
  canonical_investigation: SherlockInvestigation;
  created_at: string;
}

export interface BuildAuditArtifactEnvelopeInput {
  investigation: SherlockInvestigation;
  investigationId: string;
  snapshotId: string;
  parentSnapshotId: string | null;
  modelVersion: string;
  promptVersion: string;
  retrievedMemory: RetrievedMemoryForAudit;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: () => Date;
}

export function buildAuditArtifactEnvelope(input: BuildAuditArtifactEnvelopeInput): AuditArtifactEnvelope {
  const now = input.now ?? (() => new Date());
  return {
    schema_version: AUDIT_ARTIFACT_SCHEMA_VERSION,
    case_id: input.investigation.meta.case_id,
    investigation_id: input.investigationId,
    snapshot_id: input.snapshotId,
    parent_snapshot_id: input.parentSnapshotId,
    iteration: input.investigation.meta.iteration,
    model_version: input.modelVersion,
    prompt_version: input.promptVersion,
    case_envelope: { meta: input.investigation.meta, case: input.investigation.case },
    retrieved_memory: input.retrievedMemory,
    canonical_investigation: input.investigation,
    created_at: now().toISOString(),
  };
}

/** Deterministic serialization (sorted keys, stable across property insertion order) — required before hashing, so the same logical envelope always hashes identically. */
export function serializeAuditArtifact(envelope: AuditArtifactEnvelope): string {
  return canonicalize(envelope);
}

export function computeArtifactSha256(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/** Strips anything that isn't a safe path segment character, collapses traversal sequences, and rejects a segment that sanitizes to nothing. Applied independently to every key segment — never to the assembled key as a whole, so a case_id containing "/" cannot inject extra path segments. */
export function sanitizeArtifactKeySegment(segment: string): string {
  const stripped = segment
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!stripped) throw new Error(`Audit artifact key segment sanitized to empty from input ${JSON.stringify(segment)}`);
  return stripped;
}

/** investigations/<case-id>/<investigation-id>/<snapshot-id>.json — deterministic and non-sensitive (server-owned identity only, no content). */
export function buildAuditArtifactKey(caseId: string, investigationId: string, snapshotId: string): string {
  return `investigations/${sanitizeArtifactKeySegment(caseId)}/${sanitizeArtifactKeySegment(investigationId)}/${sanitizeArtifactKeySegment(snapshotId)}.json`;
}
