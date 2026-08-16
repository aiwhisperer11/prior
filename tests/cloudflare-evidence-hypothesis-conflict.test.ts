import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type OpenAI from "openai";

import { evaluateCaseCloudflareWaf } from "../lib/server/case-cloudflare-waf-assertions";
import { evaluateCaseB } from "../lib/server/case-b-assertions";
import { evidenceSupportingAndContradictingSameHypothesis, killedByEvidenceAlsoSupportsHypothesis } from "../lib/server/investigation-assertions-shared";
import { runSherlockInvestigation } from "../lib/server/sherlock-engine";
import type { InvestigationRequest, SherlockInvestigation } from "../types/sherlock";

/**
 * Regression coverage for the general invariant: for every hypothesis,
 * supported_by and contradicted_by must cite disjoint evidence, and an
 * evidence id cited as killed_by (C3's decisive, exclusive datum) can never
 * also appear in supported_by. Both are checked structurally — never
 * hypothesis wording, never specific case content — so they generalize to
 * every case, not just the one that first surfaced the symptom.
 *
 * The literal rule was tried first as "the same evidence_id can never
 * appear in both supported_by and contradicted_by" and immediately produced
 * a real false positive against examples/case-b.expected-investigation.json
 * H1, which cited E1 in supported_by ("the deploy preceded the incident,
 * making it a candidate") and, separately, in contradicted_by ("the later
 * rollback didn't stop the errors"). On inspection this was not a case the
 * invariant should carve out: the supported_by entry's own reason text
 * admitted "not a demonstrated cause" — per P4, temporal candidacy alone is
 * never causal support, so it never belonged in supported_by in the first
 * place. The fix was in the product data, not the invariant: E1 was removed
 * from H1's supported_by in all three Case B fixtures
 * (case-b.expected-investigation.json, case-b-baseline-snapshot.json,
 * case-b-iteration2-snapshot.json), and the candidacy framing was preserved
 * as context inside the contradicted_by reason instead — see the
 * non-regression test below, which now confirms Case B is clean under the
 * *unweakened* literal invariant, not exempted from it.
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

const cloudflareRequest = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");

/** Real H5 hypothesis text from a live capture — the removed per-regex CPU limit as the missing runtime safeguard. */
const REAL_H5_STATEMENT = "The earlier refactoring error that removed the per-regular-expression CPU limit was the missing runtime safeguard that enabled a single WAF rule to exhaust edge-machine CPU.";

function baseInvestigation(): SherlockInvestigation {
  return readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");
}

/**
 * General-invariant conflict: E1 in both H5's supported_by and
 * contradicted_by, hypothesis left "active" with no killed_by — this
 * exercises evidenceSupportingAndContradictingSameHypothesis specifically,
 * independent of the killed_by check below.
 */
function withE1SupportingAndContradictingH5(investigation: SherlockInvestigation): SherlockInvestigation {
  const h5 = {
    id: "H5",
    statement: REAL_H5_STATEMENT,
    origin: "sherlock" as const,
    status: "active" as const,
    confidence: 55,
    supported_by: [
      { evidence_id: "E10", reason: "E10 directly reports that the intended single-regex CPU protection had been removed during refactoring." },
      { evidence_id: "E1", reason: "E1 shows the merged rule's regex was itself capable of catastrophic backtracking, consistent with the missing limiter being the enabling condition." },
    ],
    contradicted_by: [
      { evidence_id: "E1", reason: "E1's backtracking regex is by itself a sufficient CPU-exhaustion mechanism, which weakens the claim that the removed limiter specifically was necessary." },
    ],
    expected_but_absent_ids: [],
    would_be_refuted_by: "Source, deployment, or runtime configuration evidence showing that an effective per-regular-expression CPU limit was active on the affected edge machines at 13:42 UTC.",
    killed_by: null,
    resurrection_condition: null,
  };
  return { ...investigation, hypotheses: [...investigation.hypotheses, h5] };
}

/**
 * killed_by-specific conflict: E1 is H5's killed_by (rejected) and also a
 * supported_by entry, with contradicted_by left empty — exercises
 * killedByEvidenceAlsoSupportsHypothesis specifically, proving it fires even
 * when the conflicting id never appears in contradicted_by at all.
 */
function withE1AsKilledByAndSupport(investigation: SherlockInvestigation): SherlockInvestigation {
  const h5 = {
    id: "H5",
    statement: REAL_H5_STATEMENT,
    origin: "sherlock" as const,
    status: "rejected" as const,
    confidence: 5,
    supported_by: [
      { evidence_id: "E10", reason: "E10 directly reports that the intended single-regex CPU protection had been removed during refactoring." },
      { evidence_id: "E1", reason: "E1 shows the merged rule's regex was itself capable of catastrophic backtracking, consistent with the missing limiter being the enabling condition." },
    ],
    contradicted_by: [],
    expected_but_absent_ids: [],
    would_be_refuted_by: "Source, deployment, or runtime configuration evidence showing that an effective per-regular-expression CPU limit was active on the affected edge machines at 13:42 UTC.",
    killed_by: "E1",
    resurrection_condition: "Revive only if deployment or configuration evidence shows the per-regex limiter was never actually removed.",
  };
  return { ...investigation, hypotheses: [...investigation.hypotheses, h5] };
}

test("RED->GREEN: E1 cannot both support and contradict H5 in the same response (general invariant)", async () => {
  const tampered = withE1SupportingAndContradictingH5(baseInvestigation());

  const h5 = tampered.hypotheses.find((h) => h.id === "H5")!;
  assert.ok(h5.supported_by.some((l) => l.evidence_id === "E1"));
  assert.ok(h5.contradicted_by.some((l) => l.evidence_id === "E1"));
  assert.deepEqual(evidenceSupportingAndContradictingSameHypothesis(tampered), [{ hypothesisId: "H5", evidenceId: "E1" }]);

  const result = await runSherlockInvestigation(
    { ...cloudflareRequest, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );

  assert.equal(result.ok, false, "a model response where E1 both supports and contradicts H5 must be rejected, not accepted");
  if (result.ok) return;
  assert.equal(result.kind, "validation");
  assert.ok(
    result.validationErrors.some((e) => e.keyword === "evidence_support_contradiction_conflict" && e.message?.includes("E1 on H5")),
    JSON.stringify(result.validationErrors),
  );
});

test("RED->GREEN: E1 cannot be both H5's killed_by and a supported_by entry (killed_by-specific invariant)", async () => {
  const tampered = withE1AsKilledByAndSupport(baseInvestigation());

  const h5 = tampered.hypotheses.find((h) => h.id === "H5")!;
  assert.equal(h5.killed_by, "E1");
  assert.ok(h5.supported_by.some((l) => l.evidence_id === "E1"));
  assert.deepEqual(killedByEvidenceAlsoSupportsHypothesis(tampered), [{ hypothesisId: "H5", evidenceId: "E1" }]);
  // Confirms this scenario is NOT caught by the general check (killed_by never appears in contradicted_by here), so the two checks are independently necessary.
  assert.deepEqual(evidenceSupportingAndContradictingSameHypothesis(tampered), []);

  const result = await runSherlockInvestigation(
    { ...cloudflareRequest, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );

  assert.equal(result.ok, false, "a model response where E1 is both H5's killed_by and a supported_by entry must be rejected, not accepted");
  if (result.ok) return;
  assert.equal(result.kind, "validation");
  assert.ok(
    result.validationErrors.some((e) => e.keyword === "killed_by_evidence_also_supports" && e.message?.includes("E1 on H5")),
    JSON.stringify(result.validationErrors),
  );
});

test("non-regression: Case B's H1 is clean under the UNWEAKENED literal invariant (fixed in the fixture, not exempted in the check)", () => {
  const caseB = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const h1 = caseB.hypotheses.find((h) => h.id === "H1")!;
  assert.equal(h1.killed_by, null);
  assert.deepEqual(h1.supported_by, [], "the non-causal E1 candidacy entry was removed from supported_by, not merely tolerated by a weaker check");
  assert.ok(h1.contradicted_by.some((l) => l.evidence_id === "E1"), "the candidacy framing survives as context inside the contradicted_by reason");

  assert.deepEqual(evidenceSupportingAndContradictingSameHypothesis(caseB), []);
  assert.deepEqual(killedByEvidenceAlsoSupportsHypothesis(caseB), []);
});

test("retry that recovers: a conflict on the first attempt is retried, and a clean second response is accepted (never a silent pick)", async () => {
  const clean = baseInvestigation();
  const tampered = withE1SupportingAndContradictingH5(clean);

  const result = await runSherlockInvestigation(
    { ...cloudflareRequest, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(clean)]),
  );

  assert.equal(result.ok, true, "a clean retry must be accepted");
  if (!result.ok) return;
  assert.equal(result.investigation.hypotheses.some((h) => h.id === "H5"), false, "the accepted investigation is the clean retry, not a silently-resolved version of the tampered one");
});

test("retry that fails definitively: a conflict repeated on both attempts is rejected, not silently resolved", async () => {
  const tampered = withE1SupportingAndContradictingH5(baseInvestigation());

  const result = await runSherlockInvestigation(
    { ...cloudflareRequest, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "validation");
});

test("Cloudflare keeps its assertion contract with the restored literal invariant in place (no false positive on clean output)", async () => {
  const clean = baseInvestigation();
  const result = await runSherlockInvestigation(
    { ...cloudflareRequest, iteration: 1 } as never,
    fakeClient([JSON.stringify(clean)]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("Case B keeps its assertion contract end-to-end with the restored literal invariant in place, after the fixture fix", async () => {
  const caseBRequest = readJson<InvestigationRequest>("../examples/case-b.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const result = await runSherlockInvestigation(
    { ...caseBRequest, iteration: 1 } as never,
    fakeClient([JSON.stringify(expected)]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const assertions = evaluateCaseB(caseBRequest, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("case-specific: E5 (speculative attack-theory chat log) causally supporting the prime suspect is flagged", () => {
  const clean = baseInvestigation();
  const mutated: SherlockInvestigation = {
    ...clean,
    hypotheses: clean.hypotheses.map((h) =>
      h.id === clean.prime_suspect?.hypothesis_id
        ? { ...h, supported_by: [...h.supported_by, { evidence_id: "E5", reason: "E5 also fits the global, sudden onset the prime suspect predicts." }] }
        : h,
    ),
  };
  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, mutated);
  const check = assertions.find((a) => a.name === "The speculative attack-theory chat log (E5) never causally supports the prime suspect");
  assert.equal(check?.passed, false, JSON.stringify(check));

  const cleanAssertions = evaluateCaseCloudflareWaf(cloudflareRequest, clean);
  assert.equal(cleanAssertions.find((a) => a.name === check!.name)?.passed, true);
});

test("case-specific: E6 (CPU profiling) contradicting a non-traffic-framed hypothesis is flagged", () => {
  const clean = baseInvestigation();
  const mutated: SherlockInvestigation = {
    ...clean,
    hypotheses: clean.hypotheses.map((h) =>
      h.id === "H3" // "release pipeline failed to test for runaway CPU" -- not traffic/attack-framed
        ? { ...h, contradicted_by: [...h.contradicted_by, { evidence_id: "E6", reason: "E6 shows CPU concentrated in the WAF module, which weakens H3 relative to H2." }] }
        : h,
    ),
  };
  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, mutated);
  const check = assertions.find((a) => a.name === "CPU-profiling evidence (E6) contradicts only traffic/attack-framed hypotheses");
  assert.equal(check?.passed, false, JSON.stringify(check));

  const cleanAssertions = evaluateCaseCloudflareWaf(cloudflareRequest, clean);
  assert.equal(cleanAssertions.find((a) => a.name === check!.name)?.passed, true);
});

/**
 * P13/P14 regressions (docs/investigation-engine.md, lib/sherlock-prompt.ts
 * SYSTEM_PROMPT PROMPT_VERSION 3.5.0). Motivated by a real, non-persisted
 * runSherlockInvestigation capture (examples/case-cloudflare-waf-2019.real-capture-attempt6.json,
 * saved verbatim, not synthesized) in which H5.contradicted_by cited E6 with
 * "does not identify an independent code defect" -- describing a gap in what
 * E6 shows, not an incompatibility with H5. That capture is otherwise a
 * clean, determined H2 result: root_cause_status is "determined", H2's own
 * contradicted_by is empty, and missing_evidence M1 (a rule-level execution
 * trace) is open without downgrading the determination -- exactly the P14
 * scenario the new checks must never flag as a problem.
 */
test("real capture: P13 fires on the exact real violation (H5 contradicted via E6's absence-of-identification language)", () => {
  const realCapture = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.real-capture-attempt6.json");
  const h5 = realCapture.hypotheses.find((h) => h.id === "H5")!;
  assert.ok(
    h5.contradicted_by.some((l) => l.evidence_id === "E6" && /does not identify/i.test(l.reason)),
    "fixture must retain the real violation text this test exists to catch",
  );

  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, realCapture);
  const check = assertions.find((a) => a.name === "No contradicted_by reason uses mere absence-of-identification language (P13)");
  assert.equal(check?.passed, false, JSON.stringify(check));
  assert.match(check!.detail, /H5\.contradicted_by\[E6\]/);
});

test("real capture: P14 does not false-positive -- root cause stays determined with H2's contradicted_by empty and M1 (rule-level trace) open in missing_evidence, not contradicted_by", () => {
  const realCapture = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.real-capture-attempt6.json");
  assert.equal(realCapture.root_cause_status, "determined");
  assert.equal(realCapture.prime_suspect?.hypothesis_id, "H2");

  const h2 = realCapture.hypotheses.find((h) => h.id === "H2")!;
  assert.deepEqual(h2.contradicted_by, [], "the determined prime suspect's own contradicted_by must stay empty despite the open trace gap");

  const m1 = realCapture.missing_evidence.find((m) => m.id === "M1")!;
  assert.match(m1.description, /profiling|trace/i, "the rule-level execution-trace gap belongs in missing_evidence");
  assert.ok(m1.related_hypothesis_ids.includes("H2"), "M1 is linked to H2 as an open detail, not cited against it");

  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, realCapture);
  const p14Check = assertions.find((a) => a.name === "Determined root cause is not argued against via pending reproduction, secondary-path exclusion, or intent (P14)");
  assert.equal(p14Check?.passed, true, JSON.stringify(p14Check));
  const rootCauseCheck = assertions.find((a) => a.name === "Root cause status is determined, with a real prime suspect");
  assert.equal(rootCauseCheck?.passed, true, JSON.stringify(rootCauseCheck));
});

test("general regression: absence-of-identification language against a DIFFERENT hypothesis/evidence pair is still flagged (P13 is not E6/H5-specific)", () => {
  const clean = baseInvestigation();
  const mutated: SherlockInvestigation = {
    ...clean,
    hypotheses: clean.hypotheses.map((h) =>
      h.id === "H3"
        ? { ...h, contradicted_by: [...h.contradicted_by, { evidence_id: "E9", reason: "E9 reports post-recovery telemetry but does not confirm the specific safeguard removal H3 requires." }] }
        : h,
    ),
  };
  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, mutated);
  const check = assertions.find((a) => a.name === "No contradicted_by reason uses mere absence-of-identification language (P13)");
  assert.equal(check?.passed, false, JSON.stringify(check));
  assert.match(check!.detail, /H3\.contradicted_by\[E9\]/);

  const cleanAssertions = evaluateCaseCloudflareWaf(cloudflareRequest, clean);
  assert.equal(cleanAssertions.find((a) => a.name === check!.name)?.passed, true);
});

test("RED->GREEN: 'does not identify H' can never be recorded as contradicted_by -- general regression independent of case wording", () => {
  const clean = baseInvestigation();
  const absenceReasons = [
    "does not identify",
    "does not confirm",
    "does not mention",
    "does not isolate",
    "fails to identify",
    "fails to confirm",
  ];
  for (const phrase of absenceReasons) {
    const mutated: SherlockInvestigation = {
      ...clean,
      hypotheses: clean.hypotheses.map((h) =>
        h.id === "H3"
          ? { ...h, contradicted_by: [...h.contradicted_by, { evidence_id: "E3", reason: `E3 documents global propagation but ${phrase} a defect specific to H3's mechanism.` }] }
          : h,
      ),
    };
    const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, mutated);
    const check = assertions.find((a) => a.name === "No contradicted_by reason uses mere absence-of-identification language (P13)");
    assert.equal(check?.passed, false, `phrase "${phrase}" should have been flagged: ${JSON.stringify(check)}`);
  }
});

test("RED->GREEN: a determined prime suspect cannot be contradicted via pending reproduction/execution-trace/intent language (P14)", () => {
  const clean = baseInvestigation();
  assert.equal(clean.root_cause_status, "determined");
  const primeSuspectId = clean.prime_suspect!.hypothesis_id;

  const mutated: SherlockInvestigation = {
    ...clean,
    hypotheses: clean.hypotheses.map((h) =>
      h.id === primeSuspectId
        ? { ...h, contradicted_by: [...h.contradicted_by, { evidence_id: "E9", reason: "No preserved request-level reproduction exists, so the exact execution trace and the trigger's intent remain unconfirmed." }] }
        : h,
    ),
  };
  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, mutated);
  const check = assertions.find((a) => a.name === "Determined root cause is not argued against via pending reproduction, secondary-path exclusion, or intent (P14)");
  assert.equal(check?.passed, false, JSON.stringify(check));
  assert.match(check!.detail, new RegExp(`${primeSuspectId}.*E9`));

  const cleanAssertions = evaluateCaseCloudflareWaf(cloudflareRequest, clean);
  assert.equal(cleanAssertions.find((a) => a.name === check!.name)?.passed, true);
});

test("non-regression: a determined main mechanism coexists with pending exact reproduction and undetermined trigger intent without downgrading root_cause_status", () => {
  const realCapture = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.real-capture-attempt6.json");
  // The real capture's own coherence/next_test/missing_evidence openly state that
  // exact request-level reproduction and the triggering execution path are
  // unresolved (M1, next_test.discriminates_between H2/H5) -- P14 requires that
  // this open detail live there, and never downgrade root_cause_status.
  assert.match(realCapture.coherence.explanation, /not.*supplied|gap/i);
  assert.deepEqual(realCapture.next_test.discriminates_between, ["H2", "H5"]);
  assert.equal(realCapture.root_cause_status, "determined");
  assert.equal(realCapture.undetermined_explanation, null);
});

test("retry/reject still fires for the pre-existing structural invariants alongside the new P13/P14 case checks (no interaction/regression)", async () => {
  const tampered = withE1SupportingAndContradictingH5(baseInvestigation());
  const result = await runSherlockInvestigation(
    { ...cloudflareRequest, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
  );
  assert.equal(result.ok, false, "the general structural invariant must still reject, independent of the new P13/P14 case-layer checks");
  if (result.ok) return;
  assert.equal(result.kind, "validation");
  assert.ok(result.validationErrors.some((e) => e.keyword === "evidence_support_contradiction_conflict"));
});

test("case-specific: E1 (vulnerable-regex PR log) cited with intent-implying language is flagged", () => {
  const clean = baseInvestigation();
  const mutated: SherlockInvestigation = {
    ...clean,
    hypotheses: clean.hypotheses.map((h) =>
      h.id === "H2"
        ? { ...h, supported_by: h.supported_by.map((link) => (link.evidence_id === "E1" ? { ...link, reason: "E1 shows the engineer deliberately introduced a regex known to backtrack catastrophically." } : link)) }
        : h,
    ),
  };
  const assertions = evaluateCaseCloudflareWaf(cloudflareRequest, mutated);
  const check = assertions.find((a) => a.name === "The vulnerable-regex evidence (E1) is never cited to claim intent");
  assert.equal(check?.passed, false, JSON.stringify(check));

  const cleanAssertions = evaluateCaseCloudflareWaf(cloudflareRequest, clean);
  assert.equal(cleanAssertions.find((a) => a.name === check!.name)?.passed, true);
});
