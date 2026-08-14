import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/investigate/v2/route";
import { readV2Snapshots } from "../lib/server/v2-snapshot-store";

function post(body: unknown) {
  return POST(new Request("http://localhost/api/investigate/v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never);
}

function evidenceItem(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    source_id: sourceId,
    source_type: "log",
    locator: "detection",
    publisher: "system",
    fragment: "value",
    event_timestamp: "2026-01-01T00:00:00Z",
    recorded_at: "2026-01-01T00:00:01Z",
    retrieval_time: "2026-01-01T00:00:02Z",
    content_hash: `hash-${sourceId}`,
    observation_capability: "detection",
    entity: "unit",
    variable: "detection",
    observed_value: "confirmed",
    units: null,
    quality: "raw",
    limitations: "",
    kind: "observed" as const,
    ...overrides,
  };
}

function sourceEvidenceBody(caseId: string, items = [evidenceItem("E1")]) {
  return { input_mode: "source_evidence", case_id: caseId, original_question: "Why?", observed_phenomenon: "Outcome changed", evidence_package: items };
}

function chainStepItem(stepId: string, overrides: Record<string, unknown> = {}) {
  return {
    step_id: stepId,
    prerequisite_step: null,
    expected_event: stepId,
    actual_observation: null,
    status: "not_checked" as const,
    source: `source observing ${stepId}`,
    hypotheses: [],
    detection_opportunity: true,
    coverage: "sufficient" as const,
    ...overrides,
  };
}

function prestructuredChainBody(caseId: string, steps = [chainStepItem("detection")]) {
  return { input_mode: "prestructured_chain", case_id: caseId, original_question: "Why?", observed_phenomenon: "Outcome changed", causal_chain: steps };
}

test("rejects a body with no input_mode", async () => {
  const response = await post({ case_id: "route-no-mode", original_question: "Why?", observed_phenomenon: "X" });
  assert.equal(response.status, 400);
});

test("rejects an unknown input_mode", async () => {
  const response = await post({ input_mode: "not_a_real_mode", case_id: "route-bad-mode", original_question: "Why?", observed_phenomenon: "X" });
  assert.equal(response.status, 400);
});

test("accepts a prestructured_chain payload", async () => {
  const response = await post(prestructuredChainBody("route-chain-ok"));
  const body = (await response.json()) as { snapshot: { change_set: { kind: string } } };
  assert.equal(response.status, 200);
  assert.equal(body.snapshot.change_set.kind, "initial_creation");
});

test("accepts a source_evidence payload", async () => {
  const response = await post(sourceEvidenceBody("route-evidence-ok"));
  const body = (await response.json()) as { snapshot: { change_set: { kind: string } } };
  assert.equal(response.status, 200);
  assert.equal(body.snapshot.change_set.kind, "initial_creation");
});

test("rejects a payload with input_mode set but neither causal_chain nor evidence_package", async () => {
  const response = await post({ input_mode: "source_evidence", case_id: "route-empty-payload", original_question: "Why?", observed_phenomenon: "X" });
  assert.equal(response.status, 400);
});

test("rejects an entirely empty body", async () => {
  const response = await post({});
  assert.equal(response.status, 400);
});

test("rejects causal_chain present when input_mode is source_evidence", async () => {
  const body = { ...sourceEvidenceBody("route-cross-field-1"), causal_chain: [chainStepItem("detection")] };
  const response = await post(body);
  assert.equal(response.status, 400);
});

test("rejects evidence_package present when input_mode is prestructured_chain", async () => {
  const body = { ...prestructuredChainBody("route-cross-field-2"), evidence_package: [evidenceItem("E1")] };
  const response = await post(body);
  assert.equal(response.status, 400);
});

test("rejects unknown top-level fields, including caller-supplied snapshot_id", async () => {
  const body = { ...sourceEvidenceBody("route-unknown-field"), snapshot_id: "route-unknown-field-1", snapshot_number: 1, change_set: { kind: "initial_creation" } };
  const response = await post(body);
  assert.equal(response.status, 400);
});

test("rejects a malformed source: missing a required field", async () => {
  const item = evidenceItem("E1") as Record<string, unknown>;
  delete item.content_hash;
  const response = await post(sourceEvidenceBody("route-malformed-source", [item as never]));
  assert.equal(response.status, 400);
});

test("rejects a duplicate source_id within the same evidence_package (schema alone cannot catch this)", async () => {
  const response = await post(sourceEvidenceBody("route-dup-source-id", [evidenceItem("E1"), evidenceItem("E1", { content_hash: "hash-different" })]));
  assert.equal(response.status, 400);
});

test("rejects a causal_chain step referencing a nonexistent prerequisite_step (schema alone cannot catch this)", async () => {
  const response = await post(prestructuredChainBody("route-dangling-prereq", [chainStepItem("execution", { prerequisite_step: "reception" })]));
  assert.equal(response.status, 400);
});

test("a rejected request does not persist anything", async () => {
  const caseId = "route-no-persist-on-failure";
  await post({ input_mode: "unknown_mode", case_id: caseId });
  assert.equal(readV2Snapshots(caseId).length, 0);
});

test("a follow-up with parent_snapshot_id is accepted and reports an update change_set", async () => {
  const caseId = "route-follow-up";
  const first = (await post(sourceEvidenceBody(caseId, [evidenceItem("E1")])).then((r) => r.json())) as { snapshot: { snapshot_id: string } };
  const response = await post({ ...sourceEvidenceBody(caseId, [evidenceItem("E1"), evidenceItem("E2")]), parent_snapshot_id: first.snapshot.snapshot_id });
  const body = (await response.json()) as { snapshot: { change_set: { kind: string; evidence_added?: string[] } } };
  assert.equal(response.status, 200);
  assert.equal(body.snapshot.change_set.kind, "update");
  assert.deepEqual(body.snapshot.change_set.evidence_added, ["E2"]);
});

test("rejects invalid JSON bodies without throwing", async () => {
  const response = await POST(new Request("http://localhost/api/investigate/v2", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" }) as never);
  assert.equal(response.status, 400);
});

test("v2 endpoint derives a question from an unresolved causal link and persists it", async () => {
  const caseId = "route-generic-chain";
  const body = prestructuredChainBody(caseId, [
    chainStepItem("detect", { expected_event: "detection", actual_observation: "detected", status: "observed", source: "detection log", hypotheses: ["H1"] }),
    chainStepItem("receive", { prerequisite_step: "detect", expected_event: "signal reception", source: "receiver log", hypotheses: ["H1", "H2"] }),
  ]);
  const response = await post(body);
  const responseBody = (await response.json()) as { snapshot: { investigator_result: { schema_version: string; next_discriminating_question: { step_id: string } | null; epistemic_status: string } } };
  assert.equal(response.status, 200);
  assert.equal(responseBody.snapshot.investigator_result.schema_version, "2.0.0");
  assert.equal(responseBody.snapshot.investigator_result.next_discriminating_question?.step_id, "receive");
  assert.equal(responseBody.snapshot.investigator_result.epistemic_status, "insufficient_evidence");
  assert.equal(JSON.stringify(responseBody).includes("confidence"), false);
  assert.equal(JSON.stringify(responseBody).includes("prime_suspect"), false);
  assert.equal(readV2Snapshots(caseId).length, 1);
});
