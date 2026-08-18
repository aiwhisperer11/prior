import assert from "node:assert/strict";
import test from "node:test";

import { userHypothesesPreserved } from "../lib/server/investigation-assertions-shared";
import { prepareInvestigationRequest } from "../lib/server/sherlock-engine";
import type { InvestigationRequest, SherlockHypothesis, SherlockInvestigation } from "../types/sherlock";

/**
 * Deterministic, model-free reproduction for fix/user-hypothesis-canonicalization.
 *
 * Reported symptom: in 2/5 live runs, a hypothesis the user supplied was
 * paraphrased or reordered by the model and was no longer recognized as
 * origin="user". These tests exercise the real production functions
 * (userHypothesesPreserved, prepareInvestigationRequest) using hand-built
 * fixtures -- no OpenAI client, no network call.
 *
 * Outcome of the fix: the reported symptom is closed by server-owned seed
 * reservation, not by patching userHypothesesPreserved itself -- see
 * computeUserHypothesisSeeds / userHypothesisSeedViolations in
 * lib/server/investigation-assertions-shared.ts and their regression suite
 * in tests/user-hypothesis-seed-canonicalization.test.ts, which is where the
 * live gate that actually blocks a bad response now lives.
 * userHypothesesPreserved is deliberately left unmodified (kept only for
 * reading snapshots persisted before seed reservation existed; see its own
 * doc comment). The two tests below still marked "documents a legacy
 * limitation" assert the heuristic's actual, known-limited behavior -- they
 * are green by design, a permanent record of exactly what the retired
 * fuzzy-matching heuristic could never do, not an outstanding bug to fix.
 * (A third such case, a reordered list-style paraphrase, was removed here as
 * a pure duplicate of the reorder case already covered below; both failure
 * modes now have their correct-behavior counterpart exercised in
 * tests/user-hypothesis-seed-canonicalization.test.ts.) The follow-up test
 * furthest below exercises prepareInvestigationRequest directly (not the
 * heuristic) and documents a real fix: that specific drop was closed in
 * prepareInvestigationRequest's iteration branch, which now validates and
 * forwards user_hypotheses instead of silently discarding it.
 */

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

function baseHypothesis(overrides: Partial<SherlockHypothesis> = {}): SherlockHypothesis {
  return {
    id: "H1",
    statement: "placeholder",
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

function investigationWith(hypotheses: SherlockHypothesis[]): SherlockInvestigation {
  return {
    schema_version: "1.0.0",
    meta: { case_id: "case-x", case_title: "Case X", iteration: 1, domain: "test" },
    case: {
      observed_outcome: "Observed",
      expected_behavior: "Expected",
      evidence: [{ id: "E1", label: "L", content: "C", provided_in_iteration: 1, provenance: null }],
    },
    expectation_matrix: { expected_present: [], unexpected_present: [], expected_absent: [], unexpected_absent: [] },
    anomalies: [],
    hypotheses,
    missing_evidence: [],
    root_cause_status: "determined",
    undetermined_explanation: null,
    prime_suspect: hypotheses.length
      ? { hypothesis_id: hypotheses[0].id, justification: "j", condemning_datum: "c", absolving_datum: "a" }
      : null,
    coherence: { score: 50, explanation: "e" },
    open_case_index: { score: 50, explanation: "e" },
    next_test: { description: "d", discriminates_between: ["H1", "H2"], outcome_map: [], does_not_discriminate_from: [] },
    mirror_question: "q",
    learning: { is_baseline: true, summary: "s", updates: [] },
  };
}

// --- 1. Core reproduction: clause-level reorder ------------------------------

/**
 * Documents a legacy limitation (accepted, not fixed): this is the reported
 * live fragility itself. The model returns the user's hypothesis with
 * identical meaning and every original word intact, but reorders clauses
 * ("X caused Y" -> "Y was caused by X"). userHypothesesPreserved's
 * isWordSubsequence requires the user's words to appear IN ORDER inside the
 * model's statement (or vice versa); a clause-level reorder breaks that in
 * both directions, so this asserts the heuristic's actual verdict: a
 * faithfully preserved user hypothesis reads as dropped. The correct verdict
 * for this exact scenario is exercised against the real fix in
 * tests/user-hypothesis-seed-canonicalization.test.ts ("RED->GREEN: a
 * reordered paraphrase of a reserved seed is rejected on both attempts") --
 * seed reservation rejects the reorder outright rather than trying to judge
 * whether it counts as "the same" hypothesis.
 */
test("legacy heuristic limitation: a faithful reorder-only paraphrase of a user hypothesis reads as not preserved", () => {
  const request = baseRequest(["A backend deployment error caused the database timeout"]);
  const investigation = investigationWith([
    baseHypothesis({ id: "H1", origin: "user", statement: "The database timeout was caused by a backend deployment error" }),
  ]);

  assert.equal(
    userHypothesesPreserved(request, investigation),
    false,
    "known limitation: the heuristic requires order-preserving word overlap, so a same-meaning clause reorder reads as a dropped hypothesis",
  );
});

// --- 2. Origin incorrecto: relabeled as origin=sherlock ----------------------

/**
 * Non-regression baseline (already correct today): if the model relabels a
 * user-supplied hypothesis's origin to "sherlock" -- appropriating it as its
 * own -- userHypothesesPreserved must still report it as not preserved, even
 * when the statement text is untouched. Kept as a checkpoint so a future fix
 * cannot accidentally loosen this into a false positive.
 */
test("a user hypothesis relabeled with origin=sherlock is correctly reported as not preserved", () => {
  const request = baseRequest(["A backend deployment error caused the database timeout"]);
  const investigation = investigationWith([
    baseHypothesis({ id: "H1", origin: "sherlock", statement: "A backend deployment error caused the database timeout" }),
  ]);

  assert.equal(userHypothesesPreserved(request, investigation), false);
});

// --- 3. Decoy: model hypothesis similar in topic but not user-supplied ------

/**
 * Non-regression baseline (already correct today): the model drops the
 * user's hypothesis entirely but proposes its own, thematically similar,
 * origin="sherlock" hypothesis. A same-topic decoy under the wrong origin
 * must not be mistaken for preservation of the user's actual claim.
 */
test("a thematically similar but genuinely model-authored decoy does not count as preserving the dropped user hypothesis", () => {
  const request = baseRequest(["A backend deployment error caused the database timeout"]);
  const investigation = investigationWith([
    baseHypothesis({ id: "H1", origin: "sherlock", statement: "A backend configuration change likely caused elevated database timeouts" }),
  ]);

  assert.equal(userHypothesesPreserved(request, investigation), false);
});

// --- 4. Two similar user hypotheses merged into one model hypothesis -------

/**
 * Documents a legacy limitation (accepted, not fixed): userHypothesesPreserved
 * has no notion of 1:1 identity between a user_hypotheses entry and a
 * specific output hypothesis. It only asks, independently for each user
 * statement, "does at least one origin=user hypothesis textually contain (or
 * get contained by) this statement's words, in order?" Two distinct user
 * hypotheses that the model merges into a single broader origin=user
 * hypothesis can each independently satisfy that existential check against
 * the SAME merged hypothesis, so this asserts the heuristic's actual,
 * over-permissive verdict: an actual loss of one hypothesis's distinct
 * identity, confidence, and reasoning reads as both being preserved. The
 * correct verdict for this exact scenario is exercised against the real fix
 * in tests/user-hypothesis-seed-canonicalization.test.ts ("RED->GREEN: two
 * reserved seeds fused into a single hypothesis are rejected on both
 * attempts") -- seed reservation gives every user hypothesis its own id, so
 * a merge can never satisfy two seeds' worth of identity with one hypothesis.
 */
test("legacy heuristic limitation: two distinct user hypotheses merged into one model hypothesis read as both preserved", () => {
  const request = baseRequest([
    "Server capacity limits caused the outage",
    "Network capacity limits caused the outage",
  ]);
  const investigation = investigationWith([
    baseHypothesis({ id: "H1", origin: "user", statement: "Server and network capacity limits caused the outage" }),
  ]);

  assert.equal(
    userHypothesesPreserved(request, investigation),
    true,
    "known limitation: the heuristic has no 1:1 mapping, so a single merged hypothesis can satisfy both original statements' existential word-subsequence check",
  );
});

// --- 5. Follow-up: identity must survive across iterations -----------------

/**
 * FIXED (was RED): a follow-up request that re-supplies user_hypotheses --
 * e.g. a caller adding a new user hypothesis on iteration 2 -- used to be
 * silently dropped by prepareInvestigationRequest's iteration branch, which
 * rebuilt the InvestigationIterationRequest field-by-field from
 * previous_snapshot.meta/.case only and never read or forwarded
 * body.user_hypotheses. That branch now validates and forwards it (see
 * sherlock-engine.ts), and runSherlockInvestigation's computeUserHypothesisSeeds
 * combines it with previous_snapshot.hypotheses' origin=user entries to
 * reserve ids for both carried and newly-supplied user hypotheses -- see
 * tests/user-hypothesis-seed-canonicalization.test.ts for full end-to-end
 * coverage of that mechanism. This test now guards the specific fix below:
 * user_hypotheses must reach the prepared iteration request unmodified.
 */
test("prepareInvestigationRequest forwards user_hypotheses on a follow-up iteration request", () => {
  const previousSnapshot: SherlockInvestigation = investigationWith([
    baseHypothesis({ id: "H1", origin: "user", statement: "A backend deployment error caused the database timeout" }),
  ]);

  const result = prepareInvestigationRequest({
    previous_snapshot: previousSnapshot,
    new_evidence: [{ label: "New log", content: "Additional detail." }],
    user_hypotheses: ["A backend deployment error caused the database timeout"],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.request.user_hypotheses,
    ["A backend deployment error caused the database timeout"],
    "a caller re-supplying the same user hypothesis on a follow-up should still have it carried as user_hypotheses on the prepared iteration request",
  );
});
