# Evaluation Notes

Block 2B's initial live evaluation reported 10/11 assertions passing because
the `next_test` assertion failed. Inspection of the generated artifact showed
that the model had already produced a structurally discriminating test between
H3 and H4: one outcome favored H4 and weakened H3, the prime suspect.

The root cause was therefore a false negative in the evaluator, not the prompt.
The prompt was restored unchanged at v3.0, and the evaluator was rewritten to
verify structural discrimination rather than rely on prose heuristics.
Regression tests were added for that evaluator behavior. The final live
evaluation passed 11/11 assertions.

## Generalization protocol

Passing Case B alone does not prove the falsification methodology (the prompt
in `lib/sherlock-prompt.ts`, the engine in `lib/server/sherlock-engine.ts`, and
the structural-assertion technique) generalizes — it only proves the pipeline
works for one fixture that may have been iterated on until it passed. Case B's
`fixture + structural assertions + live eval` pattern
(`examples/case-b.json` + `lib/server/case-b-assertions.ts` +
`scripts/eval-case-b.ts`) is the *template*, not the proof by itself.

To register a new case that counts as evidence the framework generalizes:

1. **Source the fixture from real, verifiable, independently-sourced evidence**
   — a real incident with timestamps and quotable facts (a public postmortem,
   a regulatory filing, your own logs), not an invented scenario. Cite the
   source in the assertions file's header comment.
2. **Write case-specific assertions on top of the shared, domain-agnostic
   helpers** in `lib/server/investigation-assertions-shared.ts`
   (`sharedAssertions`, `genericFillerFields`, `unknownEvidenceIds`,
   `userHypothesesPreserved`, `rejectedHypothesesSatisfyLifecycle`,
   `nextTestDiscriminatesPrimeSuspect`) — these encode the domain-independent
   principles from the prompt (P1, P9, P11, C3) and must not be
   reimplemented per case. Add only what's specific to this case's expected
   outcome (e.g. which hypothesis should lead, which should be killed and by
   what evidence).
3. **Register a live eval script** (`scripts/eval-case-<name>.ts`, mirroring
   `scripts/eval-case-b.ts`) that calls the real model with `OPENAI_API_KEY`
   and reports PASS/FAIL per assertion. A fake-client test in `tests/` may
   also exist for fast, API-key-free CI, but it only tests plumbing — it is
   never itself evidence the model reasons correctly.

The framework is only considered validated when **every registered case**
passes its live eval, not just Case B. A second case
(`case-cloudflare-waf-2019`, sourced from Cloudflare's own postmortem at
blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/) was
added specifically to stress a different failure shape than Case B: a
documented false lead the real responders themselves briefly held (a
suspected attack, refuted by their own CPU profiling) and a different root
cause mechanism (a regex causing runaway CPU, enabled by two independently
missing safeguards), rather than Case B's silent-cron-job shape. Run
`npm run eval:case-b` and `npm run eval:case-cloudflare` to check both.

A third case (`case-google-secops-2026`, sourced from Google Cloud's own status
page at status.cloud.google.com/security/incidents/wCAYU8nZcNY1sMVJPb7p,
captured 2026-08-12) stresses a different requirement entirely: Google resolved
the incident without ever publishing a root cause, so there is no public ground
truth to converge on. This case does not test whether Sherlock guesses the
right mechanism — it tests whether Sherlock correctly declares the cause
undetermined instead of inventing one, per the epistemic checks in
`lib/server/case-google-secops-assertions.ts`. Run
`npm run eval:case-google-secops` to check it.

## Case Google-SecOps: live evaluation results

First live run (real `OPENAI_API_KEY` call, prompt/schema unchanged): 12/14
assertions passed. Two failures, two different causes:

1. **A real evaluator false negative.** `Separates operational recovery from
   causal explanation` failed even though the model's reasoning correctly
   made the distinction: "E2 says the cause was under investigation and E10
   resolves the incident without stating one." The original regex required
   a resolution/mitigation word to be followed by a negation *and then* a
   repeated "cause" — this sentence instead states "the cause" once, up
   front, then refers back to it with the pronoun "one" after "without
   stating." Fixed by splitting the check into two independent, ANDed
   signals (`MENTIONS_CAUSE_PATTERN` anywhere in the text, plus
   `RESOLUTION_WITHOUT_CONFIRMING_PATTERN` for the resolve/mitigate +
   negation + confirmation-verb combination) instead of one strict
   left-to-right sequence, in `lib/server/case-google-secops-assertions.ts`.
   Regression test added in `tests/case-google-secops-engine.test.ts`.
   Re-scoring the same saved live result (no new API call) went to 13/14.

2. **A real, un-patched finding.** `Proposes at least two plausible, distinct
   mechanism hypotheses` still fails: the model generated only one
   sherlock-origin hypothesis (the "root cause undetermined" framing) plus
   the user-seeded backlog/capacity hypothesis — it never proposed a second
   candidate mechanism (defective deploy, shared dependency, index
   corruption) despite the case containing a real, usable clue for one (E5's
   simultaneous three-service onset, a natural cue for a shared-dependency or
   bad-deploy hypothesis). This is left as-is: per the standing instruction
   for this case, the evaluator is not adjusted to force a pass. The model
   was epistemically disciplined about not overclaiming a cause, but settled
   into "undetermined" without exploring the hypothesis space as broadly as
   the case invites — a real, reportable gap in P5 ("generate your own...
   hypothesis") breadth, not a defect in how the check is written.

## Conceptual fix: root_cause_status is not a hypothesis

The 13/14 result above was scored under the *original* schema, where "the
cause is undetermined" was modeled as an ordinary sherlock-origin hypothesis
(H4) that could — and did — become `prime_suspect`. That conflated two
different questions: "is a specific mechanism responsibly determinable?" and
"if so, which hypothesis is it?" A hypothesis is supposed to be a falsifiable
candidate *mechanism* (P5); "we don't know" is not a mechanism, and forcing it
into the hypotheses array meant it competed against real mechanism hypotheses
for confidence and coherence in a way that didn't make sense, and diluted
`atLeastTwoPlausibleMechanismHypotheses`-style checks (the pseudo-hypothesis
itself was one of the "two").

Fixed by adding two independent schema fields (`lib/investigation.schema.json`,
`types/sherlock.ts`): `root_cause_status: "determined" | "undetermined"` and
`undetermined_explanation: string | null`, and making `prime_suspect` nullable.
`prime_suspect` is now null whenever `root_cause_status` is `"undetermined"`;
C4 and P5 in `lib/sherlock-prompt.ts` (prompt version bumped to 3.2.0) now
explicitly forbid modeling the epistemic conclusion as a hypothesis or
selecting it as prime_suspect. `nextTestDiscriminatesPrimeSuspect`
(`lib/server/investigation-assertions-shared.ts`) gained a second mode for
`prime_suspect === null`: instead of requiring an outcome that weakens *the*
prime suspect, it requires an outcome that favors one genuine rival and
weakens a different one among the real candidate hypotheses — P9's intent
("discriminate the top competing hypotheses") survives even with no current
leader.

`case-google-secops-assertions.ts` was rewritten accordingly: "the output
recognizes the cause as undetermined" is now a structural check
(`root_cause_status === "undetermined" && prime_suspect === null &&
undetermined_explanation` non-empty) instead of regex text-matching, and a
new check (`noHypothesisRestatesUndeterminedAsMechanism`) guards against the
model still smuggling that conclusion into a hypothesis statement. Case B and
Cloudflare (both real "determined" cases) got `root_cause_status: "determined"`
and `undetermined_explanation: null` added to their fixtures — no other change,
since they already had a real, evidence-supported leading mechanism.

### Post-refactor live verification

A fresh `npm run eval:case-google-secops` run against the new schema (real
`OPENAI_API_KEY` call, independent of the 13/14 run above — a new investigation,
not a re-score) first reported 11/14, with three failures:

1. **`User hypotheses preserve origin=user` — real false negative.** The model
   extended the user's hypothesis from "...caused the freshness delays" to
   "...caused the data-freshness delays and downstream Search and Rule
   re-evaluation impact" — a faithful mid-phrase insertion ("data-") plus a
   trailing extension, keeping every original word in order. Strict substring
   containment rejected this as a dropped hypothesis. Fixed by replacing
   substring containment with an order-preserving word-subsequence check
   (`isWordSubsequence` in `lib/server/investigation-assertions-shared.ts`) —
   still deterministic and structural, not fuzzy similarity. Regression tests
   added, including a negative case confirming out-of-order/unrelated text is
   still rejected.
2. **`Proposes at least two plausible, distinct mechanism hypotheses` — real
   false negative.** The model's shared-dependency hypothesis read "A shared
   regional data-availability dependency", but the mechanism pattern required
   "shared" immediately adjacent to "dependency". Fixed by allowing up to four
   intervening descriptive words in the "shared dependency" pattern in
   `case-google-secops-assertions.ts`. This is a narrow robustness fix to
   recognize an already-intended category with realistic phrasing — not an
   expansion of what counts as a mechanism category, which would have been
   changing the rubric's substance to force a pass.
3. **`Separates operational recovery from causal explanation` — real,
   un-patched finding.** None of `coherence.explanation`, `learning.summary`,
   `undetermined_explanation`, or `open_case_index.explanation` used
   resolve/mitigate language at all this run (confirmed by direct inspection,
   not just regex non-match) — the model's reasoning stayed implicitly
   consistent with "resolution ≠ cause" but never stated the distinction
   explicitly. Left as-is.

Re-scoring the same saved live result against both fixes (no new API call)
went to **13/14** — the `root_cause_status`/`prime_suspect`/
`undetermined_explanation` structural checks all passed cleanly on a real,
independent run, confirming the conceptual fix works against live model
output, not just the hand-authored fixture. `npm test` (fast, fixture-based)
is green at 122/122.

**Documentation note, not a schema change:** `case.evidence` in
`lib/investigation.schema.json` now explicitly documents that "evidence" means
material *supplied* to the investigation (a claim, a log line, a status
update), not a guarantee of independent validation — `evidence.content` is an
input claim to reason from (P1), not adjudicated ground truth. A future
revision may split evidence into explicit fact/inference/claim categories;
this session deliberately did not do that migration yet.

## Case Cloudflare-WAF: live evaluation results

First live run (real `OPENAI_API_KEY` call, `gpt-5.6-terra`, prompt v3.0
unchanged): 9/10 assertions passed. The only failure was
`User hypotheses preserve origin=user`. Inspection of
`.sherlock/case-cloudflare-live-result.json` showed the model had correctly
kept the user's attack hypothesis with `origin: "user"` and `status:
"weakened"` — it had simply paraphrased "we hadn't seen before" as "we had not
seen before" (a faithful contraction expansion). The strict substring
comparison in `userHypothesesPreserved` treated that as a dropped hypothesis.

This is the same class of bug as Block 2B's `next_test` false negative: a
real, correct answer scored as a failure by an evaluator that was too
literal, not a prompt or reasoning defect. Fixed by adding deterministic
contraction-expansion and punctuation normalization to
`userHypothesesPreserved` (`lib/server/investigation-assertions-shared.ts`) —
still a structural/textual check, not prose scoring. Regression tests were
added in `tests/investigation-assertions-shared.test.ts`. Re-scoring the same
saved live result against the fixed evaluator (no new API call) passed
10/10. Case B was re-verified live after the shared-helper refactor and
still passes 11/11.
