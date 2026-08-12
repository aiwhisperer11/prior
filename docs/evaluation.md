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
