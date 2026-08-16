import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type OpenAI from "openai";

import { evaluateCaseB } from "../lib/server/case-b-assertions";
import { evaluateCaseCloudflareWaf } from "../lib/server/case-cloudflare-waf-assertions";
import { evaluateCaseGoogleSecOps } from "../lib/server/case-google-secops-assertions";
import { computeUserHypothesisSeeds } from "../lib/server/investigation-assertions-shared";
import { prepareInvestigationRequest, runSherlockInvestigation } from "../lib/server/sherlock-engine";
import type { InvestigationRequest, SherlockHypothesis, SherlockInvestigation } from "../types/sherlock";

/**
 * fix/user-hypothesis-canonicalization: regression suite for the
 * server-owned seed-reservation design. A user hypothesis is assigned a
 * stable H<n> id and reserved verbatim (computeUserHypothesisSeeds) before
 * the model is ever called; runSherlockInvestigation's live gate
 * (userHypothesisSeedViolations, wired into semanticIntegrityErrorsFor)
 * rejects and retries any response that fails to echo a reserved seed
 * exactly -- no fuzzy text matching, no model-chosen id/origin trusted.
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

function hyp(base: Pick<SherlockHypothesis, "id" | "statement" | "origin">, overrides: Partial<SherlockHypothesis> = {}): SherlockHypothesis {
  return {
    status: "active",
    confidence: 50,
    supported_by: [],
    contradicted_by: [],
    expected_but_absent_ids: [],
    would_be_refuted_by: "some datum",
    killed_by: null,
    resurrection_condition: null,
    ...base,
    ...overrides,
  };
}

function investigationWith(hypotheses: SherlockHypothesis[], iteration = 1): SherlockInvestigation {
  const ids = hypotheses.map((h) => h.id);
  return {
    schema_version: "1.0.0",
    meta: { case_id: "case-x", case_title: "Case X", iteration, domain: "test" },
    case: {
      observed_outcome: "Observed",
      expected_behavior: "Expected",
      evidence: [{ id: "E1", label: "L", content: "C", provided_in_iteration: 1 }],
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
    next_test: {
      description: "d",
      discriminates_between: ids.length >= 2 ? [ids[0], ids[1]] : [ids[0] ?? "H1", "H99"],
      outcome_map: [],
      does_not_discriminate_from: [],
    },
    mirror_question: "q",
    learning: { is_baseline: iteration === 1, summary: "s", updates: [] },
  };
}

const SEED_1 = "A backend deployment error caused the database timeout";
const SEED_2 = "A misconfigured load balancer dropped healthy nodes";
const request = baseRequest([SEED_1, SEED_2]);

function cleanBaseline(): SherlockInvestigation {
  return investigationWith([
    hyp({ id: "H1", statement: SEED_1, origin: "user" }, { status: "weakened", confidence: 20 }),
    hyp({ id: "H2", statement: SEED_2, origin: "user" }, { status: "weakened", confidence: 15 }),
    hyp(
      { id: "H3", statement: "A stale DNS cache entry routed traffic to a decommissioned database replica.", origin: "sherlock" },
      { status: "active", confidence: 70 },
    ),
  ]);
}

// --- Clean baseline: seeds preserved, Sherlock hypotheses still addable ----

test("a clean response with both seeds echoed verbatim is accepted, and the model's own new hypothesis survives untouched", async () => {
  const result = await runSherlockInvestigation({ ...request, iteration: 1 } as never, fakeClient([JSON.stringify(cleanBaseline())]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const h1 = result.investigation.hypotheses.find((h) => h.id === "H1");
  const h2 = result.investigation.hypotheses.find((h) => h.id === "H2");
  const h3 = result.investigation.hypotheses.find((h) => h.id === "H3");
  assert.equal(h1?.statement, SEED_1);
  assert.equal(h1?.origin, "user");
  assert.equal(h2?.statement, SEED_2);
  assert.equal(h2?.origin, "user");
  // The model's own hypothesis (unreserved id) is untouched by seed canonicalization.
  assert.equal(h3?.origin, "sherlock");
  assert.equal(h3?.statement, "A stale DNS cache entry routed traffic to a decommissioned database replica.");
  assert.equal(h3?.confidence, 70);
});

// --- RED->GREEN: paraphrase/reorder is rejected --------------------------

test("RED->GREEN: a reordered paraphrase of a reserved seed is rejected on both attempts", async () => {
  const tampered: SherlockInvestigation = {
    ...cleanBaseline(),
    hypotheses: cleanBaseline().hypotheses.map((h) =>
      h.id === "H1" ? { ...h, statement: "The database timeout was caused by a backend deployment error" } : h,
    ),
  };

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "validation");
  assert.ok(
    result.validationErrors.some((e) => e.keyword === "user_hypothesis_seed_violation" && e.message?.includes("H1")),
    JSON.stringify(result.validationErrors),
  );
});

// --- RED->GREEN: origin changed is rejected -------------------------------

test("RED->GREEN: a reserved seed relabeled with origin=sherlock is rejected on both attempts", async () => {
  const tampered: SherlockInvestigation = {
    ...cleanBaseline(),
    hypotheses: cleanBaseline().hypotheses.map((h) => (h.id === "H1" ? { ...h, origin: "sherlock" as const } : h)),
  };

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.validationErrors.some((e) => e.keyword === "user_hypothesis_seed_violation" && e.message?.includes("H1")),
    JSON.stringify(result.validationErrors),
  );
});

// --- RED->GREEN: an omitted seed is rejected ------------------------------

test("RED->GREEN: a dropped reserved seed is rejected on both attempts", async () => {
  const tampered: SherlockInvestigation = {
    ...cleanBaseline(),
    hypotheses: cleanBaseline().hypotheses.filter((h) => h.id !== "H1"),
  };

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.validationErrors.some((e) => e.keyword === "user_hypothesis_seed_violation" && e.message?.includes("H1") && e.message?.includes("missing")),
    JSON.stringify(result.validationErrors),
  );
});

// --- RED->GREEN: two seeds fused into one is rejected ---------------------

test("RED->GREEN: two reserved seeds fused into a single hypothesis are rejected on both attempts", async () => {
  const tampered: SherlockInvestigation = {
    ...cleanBaseline(),
    hypotheses: [
      hyp({ id: "H1", statement: "A backend deployment error and a misconfigured load balancer combined to cause the outage.", origin: "user" }),
      hyp({ id: "H3", statement: "A stale DNS cache entry routed traffic to a decommissioned database replica.", origin: "sherlock" }),
    ],
  };

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  const message = result.validationErrors.find((e) => e.keyword === "user_hypothesis_seed_violation")?.message ?? "";
  // H1's seed text was altered (fused with H2's content) and H2 is missing entirely.
  assert.match(message, /H1/);
  assert.match(message, /H2/);
});

// --- RED->GREEN: a reserved id reused for a different hypothesis is rejected

test("RED->GREEN: a reserved id reused for a second, different hypothesis is rejected on both attempts", async () => {
  const tampered: SherlockInvestigation = {
    ...cleanBaseline(),
    hypotheses: [
      hyp({ id: "H1", statement: SEED_1, origin: "user" }),
      hyp({ id: "H1", statement: "A completely different, model-authored idea claiming H1's reserved slot.", origin: "sherlock" }),
      hyp({ id: "H2", statement: SEED_2, origin: "user" }),
    ],
  };

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.validationErrors.some((e) => e.keyword === "user_hypothesis_seed_violation" && e.message?.includes("H1") && e.message?.includes("reused")),
    JSON.stringify(result.validationErrors),
  );
});

// --- retry that recovers ---------------------------------------------------

test("a conflict on the first attempt is retried, and a clean second response is accepted", async () => {
  const tampered: SherlockInvestigation = {
    ...cleanBaseline(),
    hypotheses: cleanBaseline().hypotheses.map((h) =>
      h.id === "H1" ? { ...h, statement: "The database timeout was caused by a backend deployment error" } : h,
    ),
  };
  const clean = cleanBaseline();

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(clean)]),
  );

  assert.equal(result.ok, true, "a clean retry must be accepted");
  if (!result.ok) return;
  assert.equal(result.investigation.hypotheses.find((h) => h.id === "H1")?.statement, SEED_1);
});

// --- Follow-up: seeds survive across iterations ----------------------------

test("follow-up: reserved seeds from the baseline survive into iteration 2 unchanged", async () => {
  const prepared1 = prepareInvestigationRequest(request);
  assert.equal(prepared1.ok, true);
  if (!prepared1.ok) return;

  const result1 = await runSherlockInvestigation(prepared1.request, fakeClient([JSON.stringify(cleanBaseline())]));
  assert.equal(result1.ok, true);
  if (!result1.ok) return;

  const prepared2 = prepareInvestigationRequest({
    previous_snapshot: result1.investigation,
    new_evidence: [{ label: "New log", content: "Additional detail." }],
  });
  assert.equal(prepared2.ok, true);
  if (!prepared2.ok) return;

  const iteration2Response = investigationWith(
    [
      hyp({ id: "H1", statement: SEED_1, origin: "user" }, { status: "rejected", confidence: 3, killed_by: "E1", resurrection_condition: "new data" }),
      hyp({ id: "H2", statement: SEED_2, origin: "user" }, { status: "rejected", confidence: 3, killed_by: "E1", resurrection_condition: "new data" }),
      hyp({ id: "H3", statement: "A stale DNS cache entry routed traffic to a decommissioned database replica.", origin: "sherlock" }, { confidence: 90 }),
    ],
    2,
  );

  const result2 = await runSherlockInvestigation(prepared2.request, fakeClient([JSON.stringify(iteration2Response)]));
  assert.equal(result2.ok, true);
  if (!result2.ok) return;
  assert.equal(result2.investigation.hypotheses.find((h) => h.id === "H1")?.statement, SEED_1);
  assert.equal(result2.investigation.hypotheses.find((h) => h.id === "H1")?.origin, "user");
  assert.equal(result2.investigation.hypotheses.find((h) => h.id === "H2")?.statement, SEED_2);
  assert.equal(result2.investigation.hypotheses.find((h) => h.id === "H2")?.origin, "user");
});

// --- Follow-up: a new seed supplied on iteration 2 gets the next free id --

test("follow-up: a new user hypothesis supplied on iteration 2 is reserved at the next free id after the whole prior case", async () => {
  const prepared1 = prepareInvestigationRequest(request);
  assert.equal(prepared1.ok, true);
  if (!prepared1.ok) return;

  const result1 = await runSherlockInvestigation(prepared1.request, fakeClient([JSON.stringify(cleanBaseline())]));
  assert.equal(result1.ok, true);
  if (!result1.ok) return;
  // Baseline used H1 (user), H2 (user), H3 (sherlock) -- the next free id is H4.

  const newSeedStatement = "A firmware bug on the load balancer's NIC caused silent packet loss.";
  const prepared2 = prepareInvestigationRequest({
    previous_snapshot: result1.investigation,
    new_evidence: [{ label: "New log", content: "Additional detail." }],
    user_hypotheses: [newSeedStatement],
  });
  assert.equal(prepared2.ok, true);
  if (!prepared2.ok) return;
  assert.deepEqual(prepared2.request.user_hypotheses, [newSeedStatement]);

  const expectedSeeds = computeUserHypothesisSeeds(result1.investigation.hypotheses, [newSeedStatement]);
  assert.deepEqual(expectedSeeds.map((s) => s.id), ["H1", "H2", "H4"]);
  assert.equal(expectedSeeds.find((s) => s.statement === newSeedStatement)?.id, "H4");

  const iteration2Response = investigationWith(
    [
      hyp({ id: "H1", statement: SEED_1, origin: "user" }),
      hyp({ id: "H2", statement: SEED_2, origin: "user" }),
      hyp({ id: "H3", statement: "A stale DNS cache entry routed traffic to a decommissioned database replica.", origin: "sherlock" }),
      hyp({ id: "H4", statement: newSeedStatement, origin: "user" }),
    ],
    2,
  );

  const result2 = await runSherlockInvestigation(prepared2.request, fakeClient([JSON.stringify(iteration2Response)]));
  assert.equal(result2.ok, true);
  if (!result2.ok) return;
  const h4 = result2.investigation.hypotheses.find((h) => h.id === "H4");
  assert.equal(h4?.origin, "user");
  assert.equal(h4?.statement, newSeedStatement);
});

// --- No regression: Google, Cloudflare, Case B ------------------------------

test("no regression: Google SecOps clean response is accepted and its assertion contract holds under the seed gate", async () => {
  const googleRequest = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(expected)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const assertions = evaluateCaseGoogleSecOps(googleRequest, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("no regression: Cloudflare WAF clean response is accepted and its assertion contract holds under the seed gate", async () => {
  const cloudflareRequest = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");

  const result = await runSherlockInvestigation({ ...cloudflareRequest, iteration: 1 } as never, fakeClient([JSON.stringify(expected)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("no regression: Case B baseline and its iteration-2 follow-up are accepted and the assertion contract holds under the seed gate", async () => {
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
  const result2 = await runSherlockInvestigation(prepared2.request, fakeClient([JSON.stringify(iteration2Snapshot)]));
  assert.equal(result2.ok, true, JSON.stringify(!result2.ok ? result2.validationErrors : null, null, 2));
  if (!result2.ok) return;
  assert.equal(result2.investigation.hypotheses.find((h) => h.id === "H1")?.statement, "The 23:00 deploy broke the checkout flow");
  assert.equal(result2.investigation.hypotheses.find((h) => h.id === "H2")?.statement, "Database overload under evening traffic");
});

// --- Formal follow-up contract: computeUserHypothesisSeeds ----------------
// Five cases: (a) no new hypotheses carries the prior seeds unchanged;
// (b) an exact-text repeat reuses the existing seed's id; (c) a genuinely
// new statement gets the next id free across every prior id (user or
// sherlock); (d) an exact duplicate within one request is an input
// validation failure, never a silent dedup; (e) an edited restatement is a
// brand-new seed, never a mutation of the original.

test("follow-up contract (a): no new user_hypotheses supplied carries every previously-baselined seed unchanged", () => {
  const prior = [
    hyp({ id: "H1", statement: SEED_1, origin: "user" }),
    hyp({ id: "H2", statement: SEED_2, origin: "user" }),
    hyp({ id: "H3", statement: "sherlock idea", origin: "sherlock" }),
  ];

  assert.deepEqual(computeUserHypothesisSeeds(prior, undefined), [
    { id: "H1", statement: SEED_1 },
    { id: "H2", statement: SEED_2 },
  ]);
});

test("follow-up contract (b): a newly-supplied statement identical to an already-carried seed reuses that seed's id", () => {
  const prior = [hyp({ id: "H1", statement: SEED_1, origin: "user" })];

  const seeds = computeUserHypothesisSeeds(prior, [SEED_1]);

  assert.deepEqual(seeds, [{ id: "H1", statement: SEED_1 }], "re-supplying the exact same text must not mint a second id for it");
});

test("follow-up contract (c): a genuinely new statement is assigned the next free id across every prior id, user or sherlock", () => {
  const prior = [
    hyp({ id: "H1", statement: SEED_1, origin: "user" }),
    hyp({ id: "H3", statement: "sherlock idea", origin: "sherlock" }), // H2 was never used; H3 is the highest id in the case.
  ];

  const seeds = computeUserHypothesisSeeds(prior, ["A brand new user hypothesis about a firmware bug"]);

  assert.deepEqual(seeds, [
    { id: "H1", statement: SEED_1 },
    { id: "H4", statement: "A brand new user hypothesis about a firmware bug" },
  ]);
});

test("follow-up contract (d): an exact duplicate statement within a single user_hypotheses array is an input validation failure", () => {
  const result = prepareInvestigationRequest(baseRequest([SEED_1, SEED_1]));

  // Baseline requests are validated as a whole by isInvestigationRequest
  // (a single boolean gate over the full request shape, same generic
  // message as any other malformed field); the duplicate specifically is
  // what makes this request invalid -- confirmed by contrast with the
  // non-duplicate baseline request accepted throughout the rest of this file.
  assert.equal(result.ok, false);
});

test("follow-up contract (d): an exact duplicate is also rejected among a follow-up's newly-supplied user_hypotheses", async () => {
  const prepared1 = prepareInvestigationRequest(request);
  assert.equal(prepared1.ok, true);
  if (!prepared1.ok) return;
  const result1 = await runSherlockInvestigation(prepared1.request, fakeClient([JSON.stringify(cleanBaseline())]));
  assert.equal(result1.ok, true);
  if (!result1.ok) return;

  const prepared2 = prepareInvestigationRequest({
    previous_snapshot: result1.investigation,
    new_evidence: [{ label: "New log", content: "Additional detail." }],
    user_hypotheses: ["A duplicated idea", "A duplicated idea"],
  });

  assert.equal(prepared2.ok, false);
  if (prepared2.ok) return;
  assert.match(prepared2.message, /duplicate/i);
});

test("follow-up contract (e): an edited restatement of an earlier idea is a new seed at a new id -- the original is never silently mutated", () => {
  const prior = [hyp({ id: "H1", statement: SEED_1, origin: "user" })];
  const edited = "A backend deployment error, specifically a bad config push, caused the database timeout";

  const seeds = computeUserHypothesisSeeds(prior, [edited]);

  assert.deepEqual(seeds, [
    { id: "H1", statement: SEED_1 },
    { id: "H2", statement: edited },
  ]);
});

// --- applyCanonicalUserHypothesisSeeds only ever runs after the exact gate
// has already passed, and can never hide an otherwise-invalid payload ------

test("a payload with a genuinely wrong seed statement is rejected outright on both attempts -- never silently corrected into an accepted response", async () => {
  const wrongOnBothAttempts: SherlockInvestigation = {
    ...cleanBaseline(),
    hypotheses: cleanBaseline().hypotheses.map((h) => (h.id === "H1" ? { ...h, statement: "An entirely different claim the model substituted for H1." } : h)),
  };

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 } as never,
    fakeClient([JSON.stringify(wrongOnBothAttempts), JSON.stringify(wrongOnBothAttempts)]),
  );

  assert.equal(result.ok, false);
  // The ok:false branch of InvestigationEngineResult has no `investigation`
  // field at all (see lib/server/sherlock-engine.ts) -- there is no code
  // path, and no type, through which a rejected response could carry a
  // canonicalized-looking investigation object back to the caller.
  assert.equal("investigation" in result, false);
});

test("an otherwise-invalid payload (dangling evidence reference) is rejected even when every reserved seed is echoed correctly", async () => {
  const danglingReference: SherlockInvestigation = {
    ...cleanBaseline(),
    hypotheses: cleanBaseline().hypotheses.map((h) =>
      h.id === "H3" ? { ...h, supported_by: [...h.supported_by, { evidence_id: "E99", reason: "Invented by the model." }] } : h,
    ),
  };

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 } as never,
    fakeClient([JSON.stringify(danglingReference), JSON.stringify(danglingReference)]),
  );

  // Both reserved seeds (H1, H2) are perfectly echoed in this payload; only
  // an unrelated field (H3's supported_by) is invalid. Rejection must still
  // happen -- the seed gate passing is necessary, never sufficient, and
  // applyCanonicalUserHypothesisSeeds is never reached for this response.
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.validationErrors.some((e) => e.keyword === "evidence_reference"), JSON.stringify(result.validationErrors));
});
