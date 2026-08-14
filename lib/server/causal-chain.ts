import type { CausalChainStep } from "@/types/sherlock-v2";

const problematic = new Set(["expected_but_absent", "occurred_but_ineffective", "unknown_due_to_telemetry_gap", "unobservable"]);
export function firstProblematicCausalStep(steps: CausalChainStep[]): CausalChainStep | null { return steps.find((step) => problematic.has(step.observation_status)) ?? null; }
export function auditCausalChain(steps: CausalChainStep[]): string[] {
  const issues: string[] = [];
  const known = new Set<string>();
  for (const step of steps) {
    if (step.prerequisite_step && !known.has(step.prerequisite_step)) issues.push(`${step.step_id}: prerequisite must precede the step`);
    if (step.observation_status === "expected_but_absent" && (!step.detection_opportunity.trim() || !step.evidence_of_effect || !step.actual_observation)) issues.push(`${step.step_id}: absent effect requires adequate observation and actual observation`);
    if (step.observation_status === "occurred_but_ineffective" && !step.evidence_of_execution) issues.push(`${step.step_id}: ineffective action requires execution evidence`);
    if (step.observation_status === "unknown_due_to_telemetry_gap" && step.evidence_of_effect) issues.push(`${step.step_id}: telemetry gap cannot assert effect evidence`);
    known.add(step.step_id);
  }
  return issues;
}
