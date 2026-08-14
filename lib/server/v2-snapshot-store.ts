import type { CaseFile, SourceEvidence } from "@/lib/server/case-file-compiler";
import { compileCaseFile } from "@/lib/server/case-file-compiler";
import { runInvestigationFlowV2, type V2Snapshot } from "@/lib/server/investigation-v2-flow";

export type V2Input =
  | {
      input_mode: "prestructured_chain";
      case_id: string;
      original_question: string;
      observed_phenomenon: string;
      causal_chain: Parameters<typeof runInvestigationFlowV2>[0]["causal_chain"];
    }
  | {
      input_mode: "source_evidence";
      case_id: string;
      original_question: string;
      observed_phenomenon: string;
      evidence_package: SourceEvidence[];
    };

export type V2ChangeSet =
  | { kind: "initial_creation" }
  | {
      kind: "update";
      parent_snapshot_id: string;
      evidence_added: string[];
      evidence_unchanged: string[];
      /** step_ids whose investigation_question was open in the parent and is no longer open in this snapshot. */
      resolved_questions: string[];
    };

export interface StoredV2Snapshot {
  snapshot_id: string;
  snapshot_number: number;
  parent_snapshot_id: string | null;
  case_id: string;
  created_at: string;
  compiler_version: string;
  investigator_version: string;
  immutable_input: V2Input;
  compiled_case_file: CaseFile | null;
  investigator_result: V2Snapshot;
  change_set: V2ChangeSet;
}

export type CreateV2SnapshotError =
  | { kind: "parent_not_found"; parent_snapshot_id: string }
  | { kind: "parent_case_mismatch"; parent_snapshot_id: string; parent_case_id: string; expected_case_id: string }
  | { kind: "parent_not_latest"; parent_snapshot_id: string; latest_snapshot_id: string | null }
  | { kind: "missing_parent_for_existing_case"; case_id: string; latest_snapshot_id: string }
  | { kind: "input_mode_mismatch_with_parent"; parent_input_mode: V2Input["input_mode"]; input_mode: V2Input["input_mode"] }
  | { kind: "evidence_collision"; source_ids: string[] };

export type CreateV2SnapshotResult = { ok: true; snapshot: StoredV2Snapshot } | { ok: false; error: CreateV2SnapshotError };

export interface EvidenceDiff {
  evidence_added: string[];
  evidence_unchanged: string[];
  evidence_collisions: string[];
}

/**
 * Classifies `currentItems` against `parentItems` by a stable identity (e.g. source_id,
 * step_id) and a content fingerprint (e.g. content_hash). Same identity + same fingerprint
 * is unchanged; same identity + different fingerprint is a collision, not a silent update.
 */
export function diffByIdentity<T>(
  parentItems: readonly T[],
  currentItems: readonly T[],
  identity: (item: T) => string,
  fingerprint: (item: T) => string,
): EvidenceDiff {
  const parentFingerprintById = new Map(parentItems.map((item) => [identity(item), fingerprint(item)]));
  const evidence_added: string[] = [];
  const evidence_unchanged: string[] = [];
  const evidence_collisions: string[] = [];
  for (const item of currentItems) {
    const id = identity(item);
    const priorFingerprint = parentFingerprintById.get(id);
    if (priorFingerprint === undefined) evidence_added.push(id);
    else if (priorFingerprint === fingerprint(item)) evidence_unchanged.push(id);
    else evidence_collisions.push(id);
  }
  return { evidence_added, evidence_unchanged, evidence_collisions };
}

/**
 * Deterministic, order-independent serialization used as a fingerprint. Plain
 * JSON.stringify already distinguishes null / absence / "" (it omits undefined
 * object properties, but keeps null and "" as distinct output), so the only gap
 * closed here is object-key order: two structurally-equal objects written with
 * keys in a different order must fingerprint identically, and two structurally
 * different values (including nested objects/arrays) must not collide.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

/**
 * Fingerprints every field of `item` except its identity key, canonically. This is
 * "identity + canonical fingerprint of the full record" (rule A): a stable id alone
 * (source_id, step_id) never certifies that the rest of an immutable record didn't
 * change — a matching content_hash with a different fragment, observed_value, or
 * provenance metadata must still be treated as a collision, not silently unchanged.
 */
function fingerprintExcluding<T extends object>(item: T, identityKey: keyof T): string {
  const rest = Object.fromEntries(Object.entries(item).filter(([key]) => key !== identityKey));
  return canonicalize(rest);
}

function resolvedQuestionStepIds(parentResult: V2Snapshot, childResult: V2Snapshot): string[] {
  const childOpenStepIds = new Set(childResult.investigation_questions.map((question) => question.step_id));
  return parentResult.investigation_questions.map((question) => question.step_id).filter((stepId) => !childOpenStepIds.has(stepId));
}

function diffAgainstParent(parent: StoredV2Snapshot, input: V2Input): EvidenceDiff {
  if (input.input_mode === "source_evidence") {
    const parentItems = parent.immutable_input.input_mode === "source_evidence" ? parent.immutable_input.evidence_package : [];
    return diffByIdentity(parentItems, input.evidence_package, (item) => item.source_id, (item) => fingerprintExcluding(item, "source_id"));
  }
  const parentItems = parent.immutable_input.input_mode === "prestructured_chain" ? parent.immutable_input.causal_chain : [];
  return diffByIdentity(parentItems, input.causal_chain, (item) => item.step_id, (item) => fingerprintExcluding(item, "step_id"));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

/**
 * Append-only history keyed by case_id. `append` re-derives snapshot_id, snapshot_number
 * and parent_snapshot_id from the existing history and rejects anything inconsistent with
 * a strictly linear chain — this is defense-in-depth: createV2Snapshot() should never
 * produce an inconsistent candidate, but the store does not trust its caller either.
 */
export interface V2SnapshotStore {
  append(snapshot: StoredV2Snapshot): void;
  latest(caseId: string): StoredV2Snapshot | null;
  findById(snapshotId: string): StoredV2Snapshot | null;
  history(caseId: string): StoredV2Snapshot[];
}

export function createInMemoryAppendOnlySnapshotStore(): V2SnapshotStore {
  const byCaseId = new Map<string, StoredV2Snapshot[]>();

  return {
    append(snapshot) {
      const history = byCaseId.get(snapshot.case_id) ?? [];
      if (history.some((existing) => existing.snapshot_id === snapshot.snapshot_id)) {
        throw new Error(`append-only invariant violated: snapshot_id "${snapshot.snapshot_id}" already exists for case "${snapshot.case_id}"`);
      }
      const expectedNumber = history.length + 1;
      if (snapshot.snapshot_number !== expectedNumber) {
        throw new Error(`append-only invariant violated: expected snapshot_number ${expectedNumber}, got ${snapshot.snapshot_number}`);
      }
      const expectedParentId = history.length ? history[history.length - 1]!.snapshot_id : null;
      if (snapshot.parent_snapshot_id !== expectedParentId) {
        throw new Error(`append-only invariant violated: parent_snapshot_id must be "${expectedParentId}", got "${snapshot.parent_snapshot_id}"`);
      }
      byCaseId.set(snapshot.case_id, [...history, deepFreeze(structuredClone(snapshot))]);
    },
    latest(caseId) {
      const history = byCaseId.get(caseId);
      return history && history.length ? structuredClone(history[history.length - 1]!) : null;
    },
    findById(snapshotId) {
      for (const history of byCaseId.values()) {
        const found = history.find((snapshot) => snapshot.snapshot_id === snapshotId);
        if (found) return structuredClone(found);
      }
      return null;
    },
    history(caseId) {
      return structuredClone(byCaseId.get(caseId) ?? []);
    },
  };
}

/**
 * This module's backing store is an in-memory, process-local, append-only snapshot
 * history — it is NOT durable persistence: it does not survive a process restart and
 * is not shared across server instances (e.g. multiple serverless/edge workers). Treat
 * it as a correctness harness for the append-only N -> N+1 contract, not as storage.
 */
const store: V2SnapshotStore = createInMemoryAppendOnlySnapshotStore();

const CAUSAL_STEPS = ["detection", "signal", "reception", "execution", "effect"] as const;

function buildRequestFromEvidence(
  input: Extract<V2Input, { input_mode: "source_evidence" }>,
  file: CaseFile | null,
): Parameters<typeof runInvestigationFlowV2>[0] {
  return {
    case_id: input.case_id,
    original_question: input.original_question,
    observed_phenomenon: input.observed_phenomenon,
    causal_chain: CAUSAL_STEPS.map((step, index) => {
      const fact = file?.facts.find((item) => item.variable.toLowerCase().includes(step));
      return {
        step_id: step,
        prerequisite_step: index ? CAUSAL_STEPS[index - 1]! : null,
        expected_event: step,
        actual_observation: fact?.observed_value ?? null,
        status: fact ? ("observed" as const) : ("not_checked" as const),
        source: fact?.source_id ?? `source observing ${step}`,
        hypotheses: [],
        detection_opportunity: Boolean(fact),
        coverage: "sufficient" as const,
      };
    }),
  };
}

export function createV2Snapshot(input: V2Input, parentSnapshotId: string | null = null): CreateV2SnapshotResult {
  let parent: StoredV2Snapshot | null = null;

  if (parentSnapshotId !== null) {
    const found = store.findById(parentSnapshotId);
    if (!found) return { ok: false, error: { kind: "parent_not_found", parent_snapshot_id: parentSnapshotId } };
    if (found.case_id !== input.case_id) {
      return { ok: false, error: { kind: "parent_case_mismatch", parent_snapshot_id: parentSnapshotId, parent_case_id: found.case_id, expected_case_id: input.case_id } };
    }
    const latest = store.latest(input.case_id);
    if (latest?.snapshot_id !== parentSnapshotId) {
      return { ok: false, error: { kind: "parent_not_latest", parent_snapshot_id: parentSnapshotId, latest_snapshot_id: latest?.snapshot_id ?? null } };
    }
    if (found.immutable_input.input_mode !== input.input_mode) {
      return { ok: false, error: { kind: "input_mode_mismatch_with_parent", parent_input_mode: found.immutable_input.input_mode, input_mode: input.input_mode } };
    }
    parent = found;
  } else {
    const latest = store.latest(input.case_id);
    if (latest) return { ok: false, error: { kind: "missing_parent_for_existing_case", case_id: input.case_id, latest_snapshot_id: latest.snapshot_id } };
  }

  let evidenceDiff: EvidenceDiff | null = null;
  if (parent) {
    evidenceDiff = diffAgainstParent(parent, input);
    if (evidenceDiff.evidence_collisions.length) return { ok: false, error: { kind: "evidence_collision", source_ids: evidenceDiff.evidence_collisions } };
  }

  const file = input.input_mode === "source_evidence" ? compileCaseFile(input.evidence_package) : null;
  const request = input.input_mode === "prestructured_chain" ? input : buildRequestFromEvidence(input, file);
  const result = runInvestigationFlowV2(request);
  const snapshotNumber = (parent?.snapshot_number ?? 0) + 1;

  const changeSet: V2ChangeSet =
    parent && evidenceDiff
      ? {
          kind: "update",
          parent_snapshot_id: parent.snapshot_id,
          evidence_added: evidenceDiff.evidence_added,
          evidence_unchanged: evidenceDiff.evidence_unchanged,
          resolved_questions: resolvedQuestionStepIds(parent.investigator_result, result),
        }
      : { kind: "initial_creation" };

  const snapshot: StoredV2Snapshot = {
    snapshot_id: `${input.case_id}-${snapshotNumber}`,
    snapshot_number: snapshotNumber,
    parent_snapshot_id: parent?.snapshot_id ?? null,
    case_id: input.case_id,
    created_at: new Date().toISOString(),
    compiler_version: "2.0.0-harness",
    investigator_version: "2.0.0-harness",
    immutable_input: input,
    compiled_case_file: file,
    investigator_result: result,
    change_set: changeSet,
  };

  store.append(snapshot);
  return { ok: true, snapshot: store.latest(input.case_id)! };
}

export function readV2Snapshots(caseId: string): StoredV2Snapshot[] {
  return store.history(caseId);
}

export type CreateV2FollowUpError = CreateV2SnapshotError | { kind: "parent_not_source_evidence"; parent_snapshot_id: string };
export type CreateV2FollowUpResult = { ok: true; snapshot: StoredV2Snapshot } | { ok: false; error: CreateV2FollowUpError };

/**
 * Server-side accumulation for a follow-up: the caller supplies only `new_evidence` and
 * the `parent_snapshot_id` it read; the server retrieves N's evidence_package, merges
 * new_evidence into it by source_id, recompiles the case file, and reruns the
 * investigation flow to produce N+1. The client never sends the accumulated package,
 * never derives change_set, and never advances questions/hypotheses itself.
 *
 * If `new_evidence` resubmits a source_id already present in N with different content,
 * the merged candidate's fingerprint for that source_id will not match N's original
 * (createV2Snapshot diffs against the untouched parent), so the contradiction still
 * surfaces as an `evidence_collision` rejection rather than a silent overwrite.
 */
export function createV2FollowUpSnapshot(caseId: string, parentSnapshotId: string, newEvidence: SourceEvidence[]): CreateV2FollowUpResult {
  const parent = store.findById(parentSnapshotId);
  if (!parent) return { ok: false, error: { kind: "parent_not_found", parent_snapshot_id: parentSnapshotId } };
  if (parent.case_id !== caseId) {
    return { ok: false, error: { kind: "parent_case_mismatch", parent_snapshot_id: parentSnapshotId, parent_case_id: parent.case_id, expected_case_id: caseId } };
  }
  if (parent.immutable_input.input_mode !== "source_evidence") {
    return { ok: false, error: { kind: "parent_not_source_evidence", parent_snapshot_id: parentSnapshotId } };
  }

  const accumulatedBySourceId = new Map(parent.immutable_input.evidence_package.map((item) => [item.source_id, item]));
  for (const item of newEvidence) accumulatedBySourceId.set(item.source_id, item);

  const input: V2Input = {
    input_mode: "source_evidence",
    case_id: caseId,
    original_question: parent.immutable_input.original_question,
    observed_phenomenon: parent.immutable_input.observed_phenomenon,
    evidence_package: [...accumulatedBySourceId.values()],
  };
  return createV2Snapshot(input, parentSnapshotId);
}
