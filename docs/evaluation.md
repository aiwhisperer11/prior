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
