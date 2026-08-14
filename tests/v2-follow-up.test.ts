import assert from "node:assert/strict";
import test from "node:test";
import { POST as createSnapshot } from "../app/api/investigate/v2/route";
import { POST as followUp } from "../app/api/investigate/v2/[case_id]/follow-up/route";
import { readV2Snapshots, type StoredV2Snapshot, type V2ChangeSet } from "../lib/server/v2-snapshot-store";

function evidenceItem(sourceId: string, variable: string, overrides: Record<string, unknown> = {}) {
  return {
    source_id: sourceId,
    source_type: "log",
    locator: variable,
    publisher: "system",
    fragment: "value",
    event_timestamp: "2026-01-01T00:00:00Z",
    recorded_at: "2026-01-01T00:00:01Z",
    retrieval_time: "2026-01-01T00:00:02Z",
    content_hash: `hash-${sourceId}`,
    observation_capability: variable,
    entity: "unit",
    variable,
    observed_value: "confirmed",
    units: null,
    quality: "raw",
    limitations: "",
    kind: "observed" as const,
    ...overrides,
  };
}

async function post(body: unknown) {
  const response = await createSnapshot(new Request("http://localhost/api/investigate/v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never);
  return { status: response.status, body: (await response.json()) as { snapshot?: StoredV2Snapshot; error?: string; issue?: unknown } };
}

async function postFollowUp(caseId: string, followUpBody: unknown) {
  const response = await followUp(
    new Request(`http://localhost/api/investigate/v2/${caseId}/follow-up`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(followUpBody) }) as never,
    { params: Promise.resolve({ case_id: caseId }) },
  );
  return { status: response.status, body: (await response.json()) as { snapshot?: StoredV2Snapshot; error?: string; issue?: unknown } };
}

function initialBody(caseId: string) {
  return {
    input_mode: "source_evidence",
    case_id: caseId,
    original_question: "Why did delivery stall?",
    observed_phenomenon: "Delivery stalled after dispatch",
    evidence_package: [evidenceItem("E-detect", "detection sensor"), evidenceItem("E-signal", "signal relay")],
  };
}

test("follow-up N -> N+1: reception is reclassified only on justifiable evidence, next question advances, a declared execution claim is not promoted to observed, N is unchanged, and change_set is traceable", async () => {
  const caseId = "followup-full-cycle";

  const created = await post(initialBody(caseId));
  assert.equal(created.status, 200);
  const n = created.body.snapshot!;

  // N: reception is not_checked and is the next discriminating question (detection/signal already observed).
  const receptionStepN = n.investigator_result.causal_chain.find((step) => step.step_id === "reception");
  assert.equal(receptionStepN?.status, "not_checked");
  assert.equal(n.investigator_result.next_discriminating_question?.step_id, "reception");
  assert.ok(n.investigator_result.investigation_questions.some((q) => q.step_id === "reception"));

  const followUpResponse = await postFollowUp(caseId, {
    parent_snapshot_id: n.snapshot_id,
    new_evidence: [
      evidenceItem("E-reception", "reception log", { observed_value: "trace confirmed" }),
      evidenceItem("E-execution-claim", "execution report", { kind: "declared", observed_value: "claimed executed" }),
    ],
  });
  assert.equal(followUpResponse.status, 200);
  const nPlus1 = followUpResponse.body.snapshot!;

  // N+1: reception is reclassified to observed only because a traceable observed log arrived.
  const receptionStepNPlus1 = nPlus1.investigator_result.causal_chain.find((step) => step.step_id === "reception");
  assert.equal(receptionStepNPlus1?.status, "observed");
  assert.equal(receptionStepNPlus1?.source, "E-reception");

  // The reception question is resolved (no longer open) and next question advances to execution.
  assert.equal(nPlus1.investigator_result.investigation_questions.some((q) => q.step_id === "reception"), false);
  assert.equal(nPlus1.investigator_result.next_discriminating_question?.step_id, "execution");

  // A declared claim about execution must not be silently promoted to an observation.
  const executionStepNPlus1 = nPlus1.investigator_result.causal_chain.find((step) => step.step_id === "execution");
  assert.equal(executionStepNPlus1?.status, "not_checked");
  assert.equal(executionStepNPlus1?.actual_observation, null);

  // N itself, re-read from the store, is byte-for-byte unchanged.
  const history = readV2Snapshots(caseId);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], n);
  assert.equal(history[0]!.snapshot_id, n.snapshot_id);

  // change_set explains the transition with traceable IDs: the client sent new_evidence,
  // not the accumulated package, yet the server-computed diff is against the full set.
  assert.equal(nPlus1.change_set.kind, "update");
  const changeSet = nPlus1.change_set as Extract<V2ChangeSet, { kind: "update" }>;
  assert.equal(changeSet.parent_snapshot_id, n.snapshot_id);
  assert.deepEqual(changeSet.evidence_added.sort(), ["E-execution-claim", "E-reception"]);
  assert.deepEqual(changeSet.evidence_unchanged.sort(), ["E-detect", "E-signal"]);
  assert.deepEqual(changeSet.resolved_questions, ["reception"]);

  // The stored evidence_package is the server-side accumulation (N's 2 + new_evidence's 2),
  // even though the client only ever sent parent_snapshot_id + new_evidence.
  if (nPlus1.immutable_input.input_mode === "source_evidence") {
    assert.equal(nPlus1.immutable_input.evidence_package.length, 4);
  }
});

test("follow-up rejects a resubmission that contradicts already-accumulated evidence, without silently picking a version", async () => {
  const caseId = "followup-contradiction";
  const created = await post(initialBody(caseId));
  const n = created.body.snapshot!;

  const rejection = await postFollowUp(caseId, {
    parent_snapshot_id: n.snapshot_id,
    new_evidence: [evidenceItem("E-detect", "detection sensor", { observed_value: "not triggered", fragment: "conflicting reading" })],
  });

  assert.equal(rejection.status, 400);
  assert.deepEqual((rejection.body.issue as { kind: string; source_ids?: string[] }).kind, "evidence_collision");
  assert.deepEqual((rejection.body.issue as { source_ids: string[] }).source_ids, ["E-detect"]);

  // No phantom N+1 was created — the contradiction was surfaced, not resolved silently.
  assert.equal(readV2Snapshots(caseId).length, 1);
});

test("follow-up rejects an unknown parent_snapshot_id", async () => {
  const result = await postFollowUp("followup-unknown-parent", { parent_snapshot_id: "does-not-exist", new_evidence: [evidenceItem("E1", "detection")] });
  assert.equal(result.status, 400);
});

test("follow-up rejects a parent snapshot that used prestructured_chain input (no evidence to accumulate into)", async () => {
  const caseId = "followup-wrong-parent-mode";
  const created = await post({
    input_mode: "prestructured_chain",
    case_id: caseId,
    original_question: "Why?",
    observed_phenomenon: "X",
    causal_chain: [{ step_id: "detect", prerequisite_step: null, expected_event: "detection", actual_observation: null, status: "not_checked", source: "s", hypotheses: [], detection_opportunity: true, coverage: "sufficient" }],
  });
  const n = created.body.snapshot!;
  const result = await postFollowUp(caseId, { parent_snapshot_id: n.snapshot_id, new_evidence: [evidenceItem("E1", "detection")] });
  assert.equal(result.status, 400);
  assert.equal((result.body.issue as { kind: string }).kind, "parent_not_source_evidence");
});

test("follow-up rejects a malformed request body (missing new_evidence)", async () => {
  const result = await postFollowUp("followup-malformed", { parent_snapshot_id: "whatever" });
  assert.equal(result.status, 400);
});

test("follow-up rejects duplicate source_id within the same new_evidence payload", async () => {
  const caseId = "followup-dup-new-evidence";
  const created = await post(initialBody(caseId));
  const n = created.body.snapshot!;
  const result = await postFollowUp(caseId, {
    parent_snapshot_id: n.snapshot_id,
    new_evidence: [evidenceItem("E-new", "reception"), evidenceItem("E-new", "reception", { content_hash: "different" })],
  });
  assert.equal(result.status, 400);
});
