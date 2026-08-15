import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type OpenAI from "openai";

import { evaluateCaseB } from "../lib/server/case-b-assertions";
import { evaluateCaseCloudflareWaf } from "../lib/server/case-cloudflare-waf-assertions";
import { evaluateCaseGoogleSecOps } from "../lib/server/case-google-secops-assertions";
import { unknownEvidenceIds } from "../lib/server/investigation-assertions-shared";
import { prepareInvestigationRequest, runSherlockInvestigation } from "../lib/server/sherlock-engine";
import type { InvestigationRequest, SherlockInvestigation } from "../types/sherlock";

/**
 * Regression coverage for the expected_but_absent_ids / unexpected_absent P3
 * discipline (lib/server/investigation-assertions-shared.ts:
 * invalidExpectedButAbsentIds, ungroundedUnexpectedAbsentIds, wired into
 * lib/server/sherlock-engine.ts's existing retry/rejection gate, after the
 * Case Envelope canonicalization boundary). expected_but_absent_ids may
 * reference only expectation_matrix.unexpected_absent items that (a) exist,
 * (b) name the owning hypothesis in related_hypothesis_ids, and (c) are
 * themselves grounded in evidence_ids that were actually checked — never a
 * missing_evidence id, evidence id, anomaly id, hypothesis id, or a
 * nonexistent/misplaced X id. Data that was never available to check
 * (internal telemetry, deploy history, a postmortem) belongs only in
 * missing_evidence.
 */

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

function fakeClient(responses: string[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: responses.shift() ?? null } }] }),
      },
    },
  } as unknown as OpenAI;
}

function googleExpected(): SherlockInvestigation {
  return readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
}

const googleRequest = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");

test("expected_but_absent_ids: [\"M1\"] is rejected (missing_evidence id, not an unexpected_absent id)", async () => {
  const candidate: SherlockInvestigation = {
    ...googleExpected(),
    hypotheses: googleExpected().hypotheses.map((h, i) => (i === 0 ? { ...h, expected_but_absent_ids: ["M1"] } : h)),
  };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(candidate), JSON.stringify(candidate)]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "validation");
  // M1 doesn't even have the X<number> shape, so the tightened schema
  // pattern (contract fix #1) rejects it before the semantic gate (#2) runs.
  assert.ok(
    result.validationErrors.some((e) => e.keyword === "pattern" && e.instancePath.includes("expected_but_absent_ids")),
    JSON.stringify(result.validationErrors),
  );
});

test("expected_but_absent_ids: [\"X999\"] is rejected (nonexistent matrix item)", async () => {
  const candidate: SherlockInvestigation = {
    ...googleExpected(),
    hypotheses: googleExpected().hypotheses.map((h, i) => (i === 0 ? { ...h, expected_but_absent_ids: ["X999"] } : h)),
  };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(candidate), JSON.stringify(candidate)]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.validationErrors.some((e) => e.keyword === "expected_but_absent_reference" && e.message?.includes("X999")), JSON.stringify(result.validationErrors));
});

test("a reference to an X outside unexpected_absent (e.g. expected_absent) is rejected", async () => {
  const base = googleExpected();
  // X4 exists, but lives in expected_absent, not unexpected_absent.
  const x4 = base.expectation_matrix.expected_absent[0]!;
  assert.equal(x4.id, "X4");
  const candidate: SherlockInvestigation = {
    ...base,
    hypotheses: base.hypotheses.map((h, i) => (i === 0 ? { ...h, expected_but_absent_ids: [x4.id] } : h)),
  };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(candidate), JSON.stringify(candidate)]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.validationErrors.some((e) => e.keyword === "expected_but_absent_reference" && e.message?.includes("X4")), JSON.stringify(result.validationErrors));
});

test("a reference to an unexpected_absent X that does not name that hypothesis is rejected", async () => {
  const base = googleExpected();
  const candidate: SherlockInvestigation = {
    ...base,
    expectation_matrix: {
      ...base.expectation_matrix,
      unexpected_absent: [{ id: "X10", description: "A genuinely observable, checked absence.", evidence_ids: ["E3"], significance: "Directly falsifies H2's predicted effect.", related_hypothesis_ids: ["H2"] }],
    },
    hypotheses: base.hypotheses.map((h) => (h.id === "H1" ? { ...h, expected_but_absent_ids: ["X10"] } : h)),
  };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(candidate), JSON.stringify(candidate)]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.validationErrors.some((e) => e.keyword === "expected_but_absent_reference" && e.message?.includes("X10") && e.message?.includes("H1")), JSON.stringify(result.validationErrors));
});

test("a valid reference to an observable, grounded unexpected_absent item is accepted", async () => {
  const base = googleExpected();
  const candidate: SherlockInvestigation = {
    ...base,
    expectation_matrix: {
      ...base.expectation_matrix,
      unexpected_absent: [{ id: "X10", description: "A genuinely observable, checked absence.", evidence_ids: ["E3"], significance: "Directly falsifies H2's predicted effect.", related_hypothesis_ids: ["H2"] }],
    },
    hypotheses: base.hypotheses.map((h) => (h.id === "H2" ? { ...h, expected_but_absent_ids: ["X10"] } : h)),
  };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(candidate)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const h2 = result.investigation.hypotheses.find((h) => h.id === "H2");
  assert.deepEqual(h2?.expected_but_absent_ids, ["X10"]);
  assert.deepEqual(result.investigation.expectation_matrix.unexpected_absent.map((x) => x.id), ["X10"]);
});

/**
 * The real reproduction: a live run kept X7-X9 in unexpected_absent, phrased
 * as "no public update identifies <internal artifact>", with no evidence_ids
 * (nothing was ever checked — there is no public queue-depth, deploy-history,
 * or postmortem data to check), and linked H1/H2/H3.expected_but_absent_ids
 * to M1/M2/M3 instead. Both violations must cause rejection.
 */
function googleLiveShapeWithX7ThroughX9(): SherlockInvestigation {
  const base = googleExpected();
  return {
    ...base,
    expectation_matrix: {
      ...base.expectation_matrix,
      unexpected_absent: [
        { id: "X7", description: "No public update identifies elevated queue depth or capacity saturation before or during the incident.", evidence_ids: [], significance: "Would help discriminate H1 from H2.", related_hypothesis_ids: ["H1"] },
        { id: "X8", description: "No public update identifies a deployment or configuration change coincident with the incident.", evidence_ids: [], significance: "Would help discriminate H2 from H1 and H3.", related_hypothesis_ids: ["H2"] },
        { id: "X9", description: "No public update identifies a shared workflow or dependency failure underlying the incident.", evidence_ids: [], significance: "Would help discriminate H3 from H1 and H2.", related_hypothesis_ids: ["H3"] },
      ],
    },
    hypotheses: base.hypotheses.map((h) => {
      if (h.id === "H1") return { ...h, expected_but_absent_ids: ["M1"] };
      if (h.id === "H2") return { ...h, expected_but_absent_ids: ["M2"] };
      if (h.id === "H3") return { ...h, expected_but_absent_ids: ["M3"] };
      return h;
    }),
  };
}

test("Google live-shaped payload with X7-X9 ('no public update identifies...') is rejected on both attempts", async () => {
  const bad = googleLiveShapeWithX7ThroughX9();

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(bad), JSON.stringify(bad)]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "validation");
  // H1/H2/H3.expected_but_absent_ids = ["M1"/"M2"/"M3"] fail the tightened
  // schema pattern outright — the exact reported shape never reaches persistence.
  assert.ok(
    result.validationErrors.some((e) => e.keyword === "pattern" && e.instancePath.includes("expected_but_absent_ids")),
    JSON.stringify(result.validationErrors),
  );
});

test("X7-X9 in unexpected_absent are rejected on their own merits (ungrounded — no evidence_ids) even when no hypothesis references them", async () => {
  // Schema-valid on its own (no M-ids anywhere): isolates the P3 semantic
  // check from the schema-pattern check above. X7-X9 sit in unexpected_absent
  // with empty evidence_ids — "no public update identifies X" was never
  // actually checked against anything, which is exactly what P3 forbids.
  const bad: SherlockInvestigation = {
    ...googleLiveShapeWithX7ThroughX9(),
    hypotheses: googleExpected().hypotheses,
  };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(bad), JSON.stringify(bad)]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "validation");
  const ungroundedError = result.validationErrors.find((e) => e.keyword === "ungrounded_unexpected_absent");
  assert.ok(ungroundedError, JSON.stringify(result.validationErrors));
  for (const id of ["X7", "X8", "X9"]) assert.ok(ungroundedError!.message?.includes(id), ungroundedError!.message);
});

test("a corrected response with M1-M3 only in missing_evidence (no X7-X9, expected_but_absent_ids empty) is accepted after retry", async () => {
  const bad = googleLiveShapeWithX7ThroughX9();
  const corrected = googleExpected();

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(bad), JSON.stringify(corrected)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.investigation.expectation_matrix.unexpected_absent, []);
  assert.deepEqual(result.investigation.hypotheses.map((h) => h.expected_but_absent_ids), [[], [], []]);
  assert.deepEqual(result.investigation.missing_evidence.map((m) => m.id).sort(), ["M1", "M2", "M3", "M4"]);
  assert.equal(result.investigation.root_cause_status, "undetermined");
  assert.equal(result.investigation.prime_suspect, null);
  assert.ok(result.investigation.hypotheses.every((h) => h.status === "active"));

  const assertions = evaluateCaseGoogleSecOps(googleRequest, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("Cloudflare keeps its real observable absences (CPU test, runtime guard) and its assertion contract", async () => {
  const request = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");

  const result = await runSherlockInvestigation({ ...request, iteration: 1 } as never, fakeClient([JSON.stringify(expected)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const cpuTestAbsence = result.investigation.expectation_matrix.expected_absent.find((item) => /test/i.test(item.description) && /cpu/i.test(item.description));
  const runtimeGuardAbsence = result.investigation.expectation_matrix.expected_absent.find((item) => /protection|guard/i.test(item.description) && /cpu/i.test(item.description));
  assert.ok(cpuTestAbsence, "CPU test absence should be preserved in expected_absent");
  assert.ok(runtimeGuardAbsence, "runtime guard absence should be preserved in expected_absent");

  const assertions = evaluateCaseCloudflareWaf(request, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("Case B and its follow-up do not regress under the new expected_but_absent_ids gate", async () => {
  const caseBRequest = readJson<InvestigationRequest>("../examples/case-b.json");
  const iteration1Expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const iteration2Snapshot = readJson<SherlockInvestigation>("../examples/case-b-iteration2-snapshot.json");
  const newEvidence = readJson<Array<{ label: string; content: string }>>("../examples/case-b-evidence-e5.json");

  const prepared1 = prepareInvestigationRequest(caseBRequest);
  assert.equal(prepared1.ok, true);
  if (!prepared1.ok) return;
  const result1 = await runSherlockInvestigation(prepared1.request, fakeClient([JSON.stringify(iteration1Expected)]));
  assert.equal(result1.ok, true);
  if (!result1.ok) return;
  const assertions1 = evaluateCaseB(caseBRequest, result1.investigation);
  assert.deepEqual(assertions1.filter((a) => !a.passed), [], JSON.stringify(assertions1, null, 2));

  const prepared2 = prepareInvestigationRequest({ previous_snapshot: result1.investigation, new_evidence: newEvidence });
  assert.equal(prepared2.ok, true);
  if (!prepared2.ok) return;
  // case-b-iteration2-snapshot.json models a different narrative branch (not
  // vetted against evaluateCaseB's case-specific expectations, e.g. deploy
  // status); what matters here is that the new expected_but_absent_ids gate
  // does not reject a legitimate follow-up, and evidence stays exact.
  const result2 = await runSherlockInvestigation(prepared2.request, fakeClient([JSON.stringify(iteration2Snapshot)]));
  assert.equal(result2.ok, true);
  if (!result2.ok) return;
  assert.deepEqual(result2.investigation.case.evidence.map((e) => e.id), ["E1", "E2", "E3", "E4", "E5"]);
  assert.deepEqual(
    unknownEvidenceIds(prepared2.request, result2.investigation),
    [],
  );
});

test("the Case Envelope canonicalization boundary still holds when the new expected_but_absent_ids gate is also in play", async () => {
  const base = googleExpected();
  // Case/meta garbled by the model; expected_but_absent_ids left valid (empty).
  const candidate: SherlockInvestigation = {
    ...base,
    meta: { case_id: "wrong-id", case_title: "Wrong title", domain: "Wrong domain", iteration: 99 },
    case: { observed_outcome: "A paraphrase the model invented.", expected_behavior: "A paraphrase the model invented.", evidence: [] },
  };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(candidate)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.investigation.meta.case_id, googleRequest.case_id);
  assert.equal(result.investigation.case.expected_behavior, googleRequest.expected_behavior);
  assert.deepEqual(result.investigation.case.evidence.map((e) => e.id), googleRequest.evidence.map((e) => e.id));
  assert.deepEqual(result.investigation.expectation_matrix.unexpected_absent, []);
});
