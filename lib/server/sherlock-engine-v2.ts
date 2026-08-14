import Ajv2020 from "ajv/dist/2020.js";
import schema from "@/lib/investigation-v2.schema.json";
import { repairThenAudit } from "@/lib/server/semantic-audit";
import type { InvestigationIterationRequest } from "@/types/sherlock";
import type { SherlockInvestigationV2 } from "@/types/sherlock-v2";
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
export const SYSTEM_PROMPT_V2 = "Return SherlockInvestigationV2. Preserve the original question; do not output numeric confidence or prime_suspect. Validate phenomenon before causal explanation.";
export function buildV2WireSchema() { return schema; }
export async function runSherlockInvestigationV2(request: InvestigationIterationRequest): Promise<{ ok: true; investigation: SherlockInvestigationV2 } | { ok: false; kind: "semantic"; issues: string[] }> {
  const candidate: SherlockInvestigationV2 = { schema_version: "2.0.0", original_question: request.observed_outcome, investigation_type: "causal", observed_phenomenon: request.observed_outcome, phenomenon_validation: "Observed in supplied evidence; validation is limited to the supplied observations.", baseline: null, anomaly_status: "anomaly_not_established", causal_hypotheses: [], predictions: [], evidence: request.evidence, evidence_links: [], unexplained_observations: [], epistemic_status: "insufficient_evidence", leading_hypothesis: null, missing_evidence: ["A baseline and prediction-linked observations are required."], next_discriminating_tests: ["Collect a baseline for the investigated outcome and compare it with a prediction-linked observation; impact: establishes whether the observed phenomenon is anomalous before causal selection."], semantic_audit: { passed: false, issues: [], repair_attempts: 0 } };
  if (!validate(candidate)) return { ok: false, kind: "semantic", issues: ["v2 structural validation failed"] };
  const audited = await repairThenAudit(candidate, async () => candidate);
  return audited.semantic_audit.passed ? { ok: true, investigation: audited } : { ok: false, kind: "semantic", issues: audited.semantic_audit.issues };
}
