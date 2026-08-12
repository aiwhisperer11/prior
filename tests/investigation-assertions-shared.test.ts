import assert from "node:assert/strict";
import test from "node:test";

import { invalidNonDiscriminatingIds, nextTestDiscriminatesPrimeSuspect, userHypothesesPreserved } from "../lib/server/investigation-assertions-shared";
import type { InvestigationRequest, NextTest, SherlockHypothesis, SherlockInvestigation } from "../types/sherlock";

function baseRequest(userHypotheses: string[]): InvestigationRequest {
  return {
    case_id: "case-x",
    case_title: "Case X",
    domain: "test",
    observed_outcome: "Observed",
    expected_behavior: "Expected",
    evidence: [{ id: "E1", label: "L", content: "C" }],
    user_hypotheses: userHypotheses,
  };
}

function investigationWithHypothesis(statement: string, origin: "user" | "sherlock"): SherlockInvestigation {
  return {
    schema_version: "1.0.0",
    meta: { case_id: "case-x", case_title: "Case X", iteration: 1, domain: "test" },
    case: { observed_outcome: "Observed", expected_behavior: "Expected", evidence: [{ id: "E1", label: "L", content: "C", provided_in_iteration: 1 }] },
    expectation_matrix: { expected_present: [], unexpected_present: [], expected_absent: [], unexpected_absent: [] },
    anomalies: [],
    hypotheses: [
      {
        id: "H1",
        statement,
        origin,
        status: "active",
        confidence: 50,
        supported_by: [],
        contradicted_by: [],
        expected_but_absent_ids: [],
        would_be_refuted_by: "some datum",
        killed_by: null,
        resurrection_condition: null,
      },
    ],
    missing_evidence: [],
    prime_suspect: { hypothesis_id: "H1", justification: "j", condemning_datum: "c", absolving_datum: "a" },
    coherence: { score: 50, explanation: "e" },
    open_case_index: { score: 50, explanation: "e" },
    next_test: { description: "d", discriminates_between: ["H1", "H2"], outcome_map: [], does_not_discriminate_from: [] },
    mirror_question: "q",
    learning: { is_baseline: true, summary: "s", updates: [] },
  };
}

function hypothesis(id: string, overrides: Partial<SherlockHypothesis> = {}): SherlockHypothesis {
  return {
    id,
    statement: `Hypothesis ${id}`,
    origin: "sherlock",
    status: "active",
    confidence: 50,
    supported_by: [],
    contradicted_by: [],
    expected_but_absent_ids: [],
    would_be_refuted_by: "some datum",
    killed_by: null,
    resurrection_condition: null,
    ...overrides,
  };
}

function investigationWithHypothesesAndNextTest(
  hypotheses: SherlockHypothesis[],
  primeSuspectId: string,
  nextTest: NextTest,
): SherlockInvestigation {
  return {
    schema_version: "1.0.0",
    meta: { case_id: "case-x", case_title: "Case X", iteration: 1, domain: "test" },
    case: { observed_outcome: "Observed", expected_behavior: "Expected", evidence: [{ id: "E1", label: "L", content: "C", provided_in_iteration: 1 }] },
    expectation_matrix: { expected_present: [], unexpected_present: [], expected_absent: [], unexpected_absent: [] },
    anomalies: [],
    hypotheses,
    missing_evidence: [],
    prime_suspect: { hypothesis_id: primeSuspectId, justification: "j", condemning_datum: "c", absolving_datum: "a" },
    coherence: { score: 50, explanation: "e" },
    open_case_index: { score: 50, explanation: "e" },
    next_test: nextTest,
    mirror_question: "q",
    learning: { is_baseline: true, summary: "s", updates: [] },
  };
}

/**
 * Regression test for a real false negative found live: the model paraphrased
 * "we hadn't seen before" as "we had not seen before" (a faithful contraction
 * expansion), which a strict substring match rejected as a dropped user
 * hypothesis.
 */
test("userHypothesesPreserved tolerates contraction expansion and punctuation differences", () => {
  const request = baseRequest(["It was a large-scale attack of a type we hadn't seen before"]);
  const investigation = investigationWithHypothesis("It was a large-scale attack of a type we had not seen before.", "user");

  assert.equal(userHypothesesPreserved(request, investigation), true);
});

test("userHypothesesPreserved still rejects a dropped user hypothesis", () => {
  const request = baseRequest(["It was a large-scale attack of a type we hadn't seen before"]);
  const investigation = investigationWithHypothesis("A catastrophic-backtracking regex caused the CPU spike.", "sherlock");

  assert.equal(userHypothesesPreserved(request, investigation), false);
});

/**
 * Regression test for a real (non-false-negative) 9/10 live run: prime
 * suspect H2 and rival H3 were not true competing alternatives (H3 read as a
 * precondition nested inside H2's mechanism), so no outcome legitimately
 * weakened H2 in favor of H3. Declaring H3 in does_not_discriminate_from
 * should let this pass, as long as a genuine rival (H4) still discriminates.
 */
test("nextTestDiscriminatesPrimeSuspect passes when a non-competing pair is honestly declared and a real rival still discriminates", () => {
  const hypotheses = [
    hypothesis("H2"),
    hypothesis("H3"),
    hypothesis("H4"),
  ];
  const nextTest: NextTest = {
    description: "d",
    discriminates_between: ["H2", "H3", "H4"],
    does_not_discriminate_from: ["H3"],
    outcome_map: [
      { observed_result: "some result", favors_hypothesis_id: "H4", weakens_hypothesis_id: "H2" },
    ],
  };
  const investigation = investigationWithHypothesesAndNextTest(hypotheses, "H2", nextTest);

  assert.equal(nextTestDiscriminatesPrimeSuspect(investigation).passed, true);
});

test("nextTestDiscriminatesPrimeSuspect still fails if every rival is declared non-competing (P9 is not dodgeable)", () => {
  const hypotheses = [hypothesis("H2"), hypothesis("H3"), hypothesis("H4")];
  const nextTest: NextTest = {
    description: "d",
    discriminates_between: ["H2", "H3", "H4"],
    does_not_discriminate_from: ["H3", "H4"],
    outcome_map: [],
  };
  const investigation = investigationWithHypothesesAndNextTest(hypotheses, "H2", nextTest);

  const result = nextTestDiscriminatesPrimeSuspect(investigation);
  assert.equal(result.passed, false);
  assert.match(result.detail, /does_not_discriminate_from/);
});

test("invalidNonDiscriminatingIds rejects an id outside discriminates_between", () => {
  const hypotheses = [hypothesis("H2"), hypothesis("H3")];
  const nextTest: NextTest = {
    description: "d",
    discriminates_between: ["H2", "H3"],
    does_not_discriminate_from: ["H9"],
    outcome_map: [],
  };
  const investigation = investigationWithHypothesesAndNextTest(hypotheses, "H2", nextTest);

  assert.deepEqual(invalidNonDiscriminatingIds(investigation), ["H9"]);
});
