import assert from "node:assert/strict";
import test from "node:test";
import { persistV2, prepareInvestigationRequestV2, readV2, runInvestigationFlowV2, type V2Request } from "../lib/server/investigation-v2-flow";

/**
 * This file tests investigation-v2-flow.ts directly (prepareInvestigationRequestV2,
 * runInvestigationFlowV2, persistV2/readV2). It previously drove these through the
 * app/api/investigate/v2 route, which has since moved to the three-layer
 * v2-snapshot-store contract (input_mode discriminator, StoredV2Snapshot response,
 * change_set). That HTTP contract is now exercised in tests/v2-route.test.ts
 * ("v2 endpoint derives a question from an unresolved causal link and persists it"),
 * which reproduces the same causal_chain fixture and the same assertions
 * (next_discriminating_question, epistemic_status, no confidence/prime_suspect leak,
 * exactly one persisted snapshot) against the current response shape and store.
 * persistV2/readV2 are exported by this module but are not wired into that route
 * (the route persists through v2-snapshot-store instead), so they are covered here
 * directly rather than through any HTTP path.
 */

const causalChain: V2Request["causal_chain"] = [
  { step_id: "detect", prerequisite_step: null, expected_event: "detection", actual_observation: "detected", status: "observed", source: "detection log", hypotheses: ["H1"], detection_opportunity: true, coverage: "sufficient" },
  { step_id: "receive", prerequisite_step: "detect", expected_event: "signal reception", actual_observation: null, status: "not_checked", source: "receiver log", hypotheses: ["H1", "H2"], detection_opportunity: true, coverage: "sufficient" },
];

test("runInvestigationFlowV2 derives a discriminating question from the first unresolved causal link", () => {
  const result = runInvestigationFlowV2({ case_id: "generic-chain", original_question: "Why did the outcome persist?", observed_phenomenon: "Outcome persisted", causal_chain: causalChain });
  assert.equal(result.schema_version, "2.0.0");
  assert.equal(result.next_discriminating_question?.step_id, "receive");
  assert.equal(result.epistemic_status, "insufficient_evidence");
  assert.equal(JSON.stringify(result).includes("confidence"), false);
  assert.equal(JSON.stringify(result).includes("prime_suspect"), false);
});

test("prepareInvestigationRequestV2 accepts a prestructured causal_chain request as-is", () => {
  const value = { case_id: "prep-chain", original_question: "Why?", observed_phenomenon: "X", causal_chain: causalChain };
  assert.deepEqual(prepareInvestigationRequestV2(value), value);
});

test("prepareInvestigationRequestV2 derives a causal_chain from an evidence_package", () => {
  const value = {
    case_id: "prep-evidence",
    original_question: "Why?",
    observed_phenomenon: "X",
    evidence_package: [{ source_id: "S1", variable: "detection sensor", observed_value: "confirmed", kind: "observed" as const }],
  };
  const request = prepareInvestigationRequestV2(value);
  assert.ok(request);
  assert.equal(request!.causal_chain[0]!.status, "observed");
  assert.equal(request!.causal_chain[1]!.status, "not_checked");
});

test("prepareInvestigationRequestV2 rejects a payload with neither causal_chain nor evidence_package", () => {
  assert.equal(prepareInvestigationRequestV2({ case_id: "x", original_question: "?", observed_phenomenon: "y" }), null);
});

test("prepareInvestigationRequestV2 rejects a non-object payload", () => {
  assert.equal(prepareInvestigationRequestV2(null), null);
  assert.equal(prepareInvestigationRequestV2("not an object"), null);
});

test("persistV2/readV2 append snapshots for a case in order", () => {
  const caseId = "flow-persist-direct";
  const base = runInvestigationFlowV2({ case_id: caseId, original_question: "Why?", observed_phenomenon: "X", causal_chain: causalChain });
  persistV2(base);
  persistV2({ ...base, epistemic_status: "sufficient_evidence" });
  const history = readV2(caseId);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.epistemic_status, "insufficient_evidence");
  assert.equal(history[1]!.epistemic_status, "sufficient_evidence");
});
