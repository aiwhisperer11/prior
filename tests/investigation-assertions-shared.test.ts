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
    case: { observed_outcome: "Observed", expected_behavior: "Expected", evidence: [{ id: "E1", label: "L", content: "C", provided_in_iteration: 1, provenance: null }] },
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
    root_cause_status: "determined",
    undetermined_explanation: null,
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
  primeSuspectId: string | null,
  nextTest: NextTest,
): SherlockInvestigation {
  return {
    schema_version: "1.0.0",
    meta: { case_id: "case-x", case_title: "Case X", iteration: 1, domain: "test" },
    case: { observed_outcome: "Observed", expected_behavior: "Expected", evidence: [{ id: "E1", label: "L", content: "C", provided_in_iteration: 1, provenance: null }] },
    expectation_matrix: { expected_present: [], unexpected_present: [], expected_absent: [], unexpected_absent: [] },
    anomalies: [],
    hypotheses,
    missing_evidence: [],
    root_cause_status: primeSuspectId === null ? "undetermined" : "determined",
    undetermined_explanation: primeSuspectId === null ? "explanation" : null,
    prime_suspect: primeSuspectId === null ? null : { hypothesis_id: primeSuspectId, justification: "j", condemning_datum: "c", absolving_datum: "a" },
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
 * Regression test for a real false negative found live: the model extended
 * "caused the freshness delays" to "caused the data-freshness delays and
 * downstream Search and Rule re-evaluation impact" — a faithful insertion
 * and trailing extension that kept every original word in order, but broke
 * strict substring containment because "data" was inserted mid-phrase.
 */
test("userHypothesesPreserved tolerates a faithful mid-phrase insertion and trailing extension", () => {
  const request = baseRequest(["A capacity or backlog problem in the data-ingestion or processing pipeline caused the freshness delays"]);
  const investigation = investigationWithHypothesis(
    "A capacity or backlog problem in the data-ingestion or processing pipeline caused the data-freshness delays and downstream Search and Rule re-evaluation impact.",
    "user",
  );

  assert.equal(userHypothesesPreserved(request, investigation), true);
});

test("userHypothesesPreserved still rejects out-of-order or unrelated word overlap", () => {
  const request = baseRequest(["A capacity or backlog problem caused the freshness delays"]);
  const investigation = investigationWithHypothesis(
    "The freshness delays caused engineers to investigate a capacity problem, unrelated to any backlog.",
    "user",
  );

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

/**
 * When root_cause_status is "undetermined" there is no prime suspect to
 * anchor P9 on — the requirement generalizes to "some outcome favors one
 * genuine rival and weakens a different one."
 */
test("nextTestDiscriminatesPrimeSuspect (undetermined mode) passes when an outcome favors one genuine rival and weakens another", () => {
  const hypotheses = [hypothesis("H1"), hypothesis("H2"), hypothesis("H3")];
  const nextTest: NextTest = {
    description: "d",
    discriminates_between: ["H1", "H2", "H3"],
    does_not_discriminate_from: ["H3"],
    outcome_map: [
      { observed_result: "some result", favors_hypothesis_id: "H2", weakens_hypothesis_id: "H1" },
    ],
  };
  const investigation = investigationWithHypothesesAndNextTest(hypotheses, null, nextTest);

  assert.equal(nextTestDiscriminatesPrimeSuspect(investigation).passed, true);
});

test("nextTestDiscriminatesPrimeSuspect (undetermined mode) fails with fewer than two genuine rivals", () => {
  const hypotheses = [hypothesis("H1"), hypothesis("H2"), hypothesis("H3")];
  const nextTest: NextTest = {
    description: "d",
    discriminates_between: ["H1", "H2", "H3"],
    does_not_discriminate_from: ["H2", "H3"],
    outcome_map: [],
  };
  const investigation = investigationWithHypothesesAndNextTest(hypotheses, null, nextTest);

  const result = nextTestDiscriminatesPrimeSuspect(investigation);
  assert.equal(result.passed, false);
  assert.match(result.detail, /Fewer than two genuine rivals/);
});

test("nextTestDiscriminatesPrimeSuspect (undetermined mode) fails when an outcome only favors, without weakening a different hypothesis", () => {
  const hypotheses = [hypothesis("H1"), hypothesis("H2")];
  const nextTest: NextTest = {
    description: "d",
    discriminates_between: ["H1", "H2"],
    does_not_discriminate_from: [],
    outcome_map: [
      { observed_result: "some result", favors_hypothesis_id: "H1", weakens_hypothesis_id: null },
    ],
  };
  const investigation = investigationWithHypothesesAndNextTest(hypotheses, null, nextTest);

  assert.equal(nextTestDiscriminatesPrimeSuspect(investigation).passed, false);
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
