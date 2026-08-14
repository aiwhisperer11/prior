import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalize,
  createInMemoryAppendOnlySnapshotStore,
  createV2Snapshot,
  diffByIdentity,
  readV2Snapshots,
  type StoredV2Snapshot,
  type V2Input,
} from "../lib/server/v2-snapshot-store";
import { runInvestigationFlowV2 } from "../lib/server/investigation-v2-flow";
import type { SourceEvidence } from "../lib/server/case-file-compiler";

function evidence(sourceId: string, contentHash: string, variable = "detection"): SourceEvidence {
  return {
    source_id: sourceId,
    source_type: "log",
    locator: variable,
    publisher: "system",
    fragment: "value",
    event_timestamp: "2026-01-01T00:00:00Z",
    recorded_at: "2026-01-01T00:00:01Z",
    retrieval_time: "2026-01-01T00:00:02Z",
    content_hash: contentHash,
    observation_capability: variable,
    entity: "unit",
    variable,
    observed_value: "confirmed",
    units: null,
    quality: "raw",
    limitations: "",
    kind: "observed",
  };
}

function sourceEvidenceInput(caseId: string, items: SourceEvidence[]): V2Input {
  return {
    input_mode: "source_evidence",
    case_id: caseId,
    original_question: "Why did the outcome change?",
    observed_phenomenon: "Outcome changed",
    evidence_package: items,
  };
}

function chainStep(stepId: string, status: "observed" | "not_checked", observation: string | null) {
  return {
    step_id: stepId,
    prerequisite_step: null,
    expected_event: stepId,
    actual_observation: observation,
    status,
    source: `source observing ${stepId}`,
    hypotheses: [] as string[],
    detection_opportunity: true,
    coverage: "sufficient" as const,
  };
}

function chainInput(caseId: string, steps: ReturnType<typeof chainStep>[]): V2Input {
  return { input_mode: "prestructured_chain", case_id: caseId, original_question: "Why?", observed_phenomenon: "Outcome changed", causal_chain: steps };
}

// The schema currently restricts actual_observation to string | null, but the store's
// fingerprint must be correct regardless — this cast simulates an unvalidated caller
// (or a future schema widening) reaching the store directly with a structured value.
function chainInputWithStructuredObservation(caseId: string, stepId: string, observation: unknown, extraSteps: ReturnType<typeof chainStep>[] = []): V2Input {
  const step = { ...chainStep(stepId, "observed", null), actual_observation: observation };
  return { input_mode: "prestructured_chain", case_id: caseId, original_question: "Why?", observed_phenomenon: "Outcome changed", causal_chain: [step, ...extraSteps] } as unknown as V2Input;
}

function unwrap(result: ReturnType<typeof createV2Snapshot>): StoredV2Snapshot {
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  if (!result.ok) throw new Error("unreachable");
  return result.snapshot;
}

test("initial snapshot: snapshot_number 1, parent_snapshot_id null, change_set is initial_creation", () => {
  const caseId = "store-initial";
  const snapshot = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  assert.equal(snapshot.snapshot_number, 1);
  assert.equal(snapshot.parent_snapshot_id, null);
  assert.deepEqual(snapshot.change_set, { kind: "initial_creation" });
});

test("second snapshot links to its parent and reports an update change_set", () => {
  const caseId = "store-update";
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  const second = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1"), evidence("E2", "h2")]), first.snapshot_id));
  assert.equal(second.snapshot_number, 2);
  assert.equal(second.parent_snapshot_id, first.snapshot_id);
  assert.equal(second.change_set.kind, "update");
  if (second.change_set.kind === "update") {
    assert.deepEqual(second.change_set.evidence_added, ["E2"]);
    assert.deepEqual(second.change_set.evidence_unchanged, ["E1"]);
  }
});

test("prestructured_chain updates diff causal_chain steps by step_id identity", () => {
  const caseId = "store-chain-update";
  const first = unwrap(createV2Snapshot(chainInput(caseId, [chainStep("detection", "observed", "seen")])));
  const second = unwrap(
    createV2Snapshot(chainInput(caseId, [chainStep("detection", "observed", "seen"), chainStep("signal", "not_checked", null)]), first.snapshot_id),
  );
  assert.equal(second.change_set.kind, "update");
  if (second.change_set.kind === "update") {
    assert.deepEqual(second.change_set.evidence_added, ["signal"]);
    assert.deepEqual(second.change_set.evidence_unchanged, ["detection"]);
  }
});

test("after creating snapshot 2, snapshot 1 remains structurally identical and history is ordered", () => {
  const caseId = "store-history-order";
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  const firstAsOriginallyReturned = structuredClone(first);
  const second = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1"), evidence("E2", "h2")]), first.snapshot_id));

  const history = readV2Snapshots(caseId);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], firstAsOriginallyReturned);
  assert.equal(history[0]!.snapshot_id, first.snapshot_id);
  assert.equal(history[1]!.snapshot_id, second.snapshot_id);
});

test("mutating the array or nested objects returned by readV2Snapshots does not affect the store", () => {
  const caseId = "store-mutation-guard";
  createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")]));

  const history = readV2Snapshots(caseId);
  const originalCausalChainLength = history[0]!.investigator_result.causal_chain.length;
  history.push({} as StoredV2Snapshot);
  history[0]!.snapshot_number = 999;
  (history[0]!.immutable_input as { case_id: string }).case_id = "tampered";
  if (history[0]!.change_set.kind === "initial_creation") {
    (history[0]!.change_set as { kind: string }).kind = "tampered";
  }
  (history[0]!.investigator_result.causal_chain as unknown[]).push("tampered");

  const rereadHistory = readV2Snapshots(caseId);
  assert.equal(rereadHistory.length, 1);
  assert.equal(rereadHistory[0]!.snapshot_number, 1);
  assert.equal(rereadHistory[0]!.immutable_input.case_id, caseId);
  assert.deepEqual(rereadHistory[0]!.change_set, { kind: "initial_creation" });
  assert.equal(rereadHistory[0]!.investigator_result.causal_chain.length, originalCausalChainLength);
});

test("rejects a parent_snapshot_id that does not exist", () => {
  const result = createV2Snapshot(sourceEvidenceInput("store-parent-missing", [evidence("E1", "h1")]), "does-not-exist-1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "parent_not_found");
});

test("rejects a parent_snapshot_id belonging to a different case_id", () => {
  const other = unwrap(createV2Snapshot(sourceEvidenceInput("store-parent-other-case", [evidence("E1", "h1")])));
  const result = createV2Snapshot(sourceEvidenceInput("store-parent-wrong-case", [evidence("E1", "h1")]), other.snapshot_id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "parent_case_mismatch");
});

test("rejects a parent_snapshot_id that is not the latest snapshot of the case (forking)", () => {
  const caseId = "store-parent-not-latest";
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1"), evidence("E2", "h2")]), first.snapshot_id));

  // Forking again from the superseded snapshot 1 would try to reuse snapshot_id "<case>-2".
  const fork = createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1"), evidence("E3", "h3")]), first.snapshot_id);
  assert.equal(fork.ok, false);
  if (!fork.ok) assert.equal(fork.error.kind, "parent_not_latest");
  assert.equal(readV2Snapshots(caseId).length, 2);
});

test("rejects creating an initial snapshot (no parent) for a case that already has history", () => {
  const caseId = "store-missing-parent-for-existing";
  unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  const result = createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "missing_parent_for_existing_case");
  assert.equal(readV2Snapshots(caseId).length, 1);
});

test("rejects switching input_mode against an established parent", () => {
  const caseId = "store-mode-mismatch";
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  const result = createV2Snapshot(chainInput(caseId, [chainStep("detection", "observed", "seen")]), first.snapshot_id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "input_mode_mismatch_with_parent");
});

test("rejects an evidence collision: same source_id, different content_hash, and does not persist it", () => {
  const caseId = "store-evidence-collision";
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  const result = createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1-different")]), first.snapshot_id);
  assert.equal(result.ok, false);
  if (!result.ok && result.error.kind === "evidence_collision") assert.deepEqual(result.error.source_ids, ["E1"]);
  assert.equal(readV2Snapshots(caseId).length, 1);
});

test("diffByIdentity classifies added, unchanged and colliding items by stable identity", () => {
  const parent = [{ id: "A", hash: "1" }, { id: "B", hash: "2" }];
  const current = [{ id: "A", hash: "1" }, { id: "B", hash: "changed" }, { id: "C", hash: "3" }];
  const diff = diffByIdentity(parent, current, (item) => item.id, (item) => item.hash);
  assert.deepEqual(diff.evidence_added, ["C"]);
  assert.deepEqual(diff.evidence_unchanged, ["A"]);
  assert.deepEqual(diff.evidence_collisions, ["B"]);
});

test("canonicalize distinguishes null, absence, and empty string", () => {
  const withNull = canonicalize({ a: null });
  const withAbsence = canonicalize({});
  const withEmptyString = canonicalize({ a: "" });
  assert.notEqual(withNull, withAbsence);
  assert.notEqual(withNull, withEmptyString);
  assert.notEqual(withAbsence, withEmptyString);
});

test("canonicalize is stable under object key reordering and still distinguishes structurally different nested values", () => {
  const a = { x: 1, y: { b: 2, a: 1 }, list: [{ q: 1, p: 2 }] };
  const b = { list: [{ p: 2, q: 1 }], y: { a: 1, b: 2 }, x: 1 };
  const c = { x: 1, y: { b: 3, a: 1 }, list: [{ q: 1, p: 2 }] };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.notEqual(canonicalize(a), canonicalize(c));
});

test("prestructured_chain diff collides on structurally different actual_observation values (objects, not just strings)", () => {
  const caseId = "store-chain-structured-collision";
  const first = unwrap(createV2Snapshot(chainInputWithStructuredObservation(caseId, "execution", { delivered: true, retries: 1 })));
  const result = createV2Snapshot(chainInputWithStructuredObservation(caseId, "execution", { delivered: true, retries: 2 }), first.snapshot_id);
  assert.equal(result.ok, false);
  if (!result.ok && result.error.kind === "evidence_collision") assert.deepEqual(result.error.source_ids, ["execution"]);
});

test("prestructured_chain diff treats the same structured actual_observation as unchanged regardless of key order", () => {
  const caseId = "store-chain-structured-unchanged";
  const first = unwrap(createV2Snapshot(chainInputWithStructuredObservation(caseId, "execution", { delivered: true, retries: 1 })));
  const second = unwrap(
    createV2Snapshot(
      chainInputWithStructuredObservation(caseId, "execution", { retries: 1, delivered: true }, [chainStep("effect", "not_checked", null)]),
      first.snapshot_id,
    ),
  );
  assert.equal(second.change_set.kind, "update");
  if (second.change_set.kind === "update") {
    assert.deepEqual(second.change_set.evidence_unchanged, ["execution"]);
    assert.deepEqual(second.change_set.evidence_added, ["effect"]);
  }
});

test("source_evidence collision: same source_id and content_hash but a different fragment", () => {
  const caseId = "store-evidence-fragment-collision";
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  const changed = { ...evidence("E1", "h1"), fragment: "a materially different fragment" };
  const result = createV2Snapshot(sourceEvidenceInput(caseId, [changed]), first.snapshot_id);
  assert.equal(result.ok, false);
  if (!result.ok && result.error.kind === "evidence_collision") assert.deepEqual(result.error.source_ids, ["E1"]);
});

test("source_evidence collision: same source_id and content_hash but a different normalized observed_value", () => {
  const caseId = "store-evidence-value-collision";
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  const changed = { ...evidence("E1", "h1"), observed_value: "a materially different normalized value" };
  const result = createV2Snapshot(sourceEvidenceInput(caseId, [changed]), first.snapshot_id);
  assert.equal(result.ok, false);
});

test("source_evidence collision: same source_id and content_hash but different provenance metadata", () => {
  const caseId = "store-evidence-provenance-collision";
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [evidence("E1", "h1")])));
  const changed = { ...evidence("E1", "h1"), publisher: "a different publisher", retrieval_time: "2026-02-01T00:00:00Z" };
  const result = createV2Snapshot(sourceEvidenceInput(caseId, [changed]), first.snapshot_id);
  assert.equal(result.ok, false);
});

test("source_evidence: a semantically equal record with reordered keys is unchanged", () => {
  const caseId = "store-evidence-key-order-unchanged";
  const original = evidence("E1", "h1");
  const first = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [original])));
  const reordered = Object.fromEntries(Object.entries(original).reverse()) as typeof original;
  const second = unwrap(createV2Snapshot(sourceEvidenceInput(caseId, [reordered, evidence("E2", "h2")]), first.snapshot_id));
  assert.equal(second.change_set.kind, "update");
  if (second.change_set.kind === "update") {
    assert.deepEqual(second.change_set.evidence_unchanged, ["E1"]);
    assert.deepEqual(second.change_set.evidence_added, ["E2"]);
  }
});

function fakeInvestigatorResult(caseId: string) {
  return runInvestigationFlowV2({ case_id: caseId, original_question: "q", observed_phenomenon: "p", causal_chain: [] });
}

function buildRawSnapshot(overrides: Partial<StoredV2Snapshot> = {}): StoredV2Snapshot {
  const caseId = overrides.case_id ?? "case";
  return {
    snapshot_id: `${caseId}-1`,
    snapshot_number: 1,
    parent_snapshot_id: null,
    case_id: caseId,
    created_at: new Date().toISOString(),
    compiler_version: "test",
    investigator_version: "test",
    immutable_input: sourceEvidenceInput(caseId, [evidence("E1", "h1")]),
    compiled_case_file: null,
    investigator_result: fakeInvestigatorResult(caseId),
    change_set: { kind: "initial_creation" },
    ...overrides,
  };
}

test("append (low-level invariant) rejects a duplicate snapshot_id", () => {
  const isolatedStore = createInMemoryAppendOnlySnapshotStore();
  const base = buildRawSnapshot();
  isolatedStore.append(base);
  const duplicate = buildRawSnapshot({ snapshot_number: 2, parent_snapshot_id: base.snapshot_id, snapshot_id: base.snapshot_id });
  assert.throws(() => isolatedStore.append(duplicate), /snapshot_id/);
  assert.equal(isolatedStore.history("case").length, 1);
});

test("append (low-level invariant) rejects a non-consecutive snapshot_number", () => {
  const isolatedStore = createInMemoryAppendOnlySnapshotStore();
  const base = buildRawSnapshot();
  isolatedStore.append(base);
  const skipped = buildRawSnapshot({ snapshot_id: "case-3", snapshot_number: 3, parent_snapshot_id: base.snapshot_id });
  assert.throws(() => isolatedStore.append(skipped), /snapshot_number/);
  assert.equal(isolatedStore.history("case").length, 1);
});

test("append (low-level invariant) rejects a parent_snapshot_id that does not match the current latest", () => {
  const isolatedStore = createInMemoryAppendOnlySnapshotStore();
  const base = buildRawSnapshot();
  isolatedStore.append(base);
  const wrongParent = buildRawSnapshot({ snapshot_id: "case-2", snapshot_number: 2, parent_snapshot_id: null });
  assert.throws(() => isolatedStore.append(wrongParent), /parent_snapshot_id/);
  assert.equal(isolatedStore.history("case").length, 1);
});
