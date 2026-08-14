import type { SherlockInvestigation } from "@/types/sherlock";
import type { SherlockInvestigationV2 } from "@/types/sherlock-v2";

/** Legacy snapshots are evidence records, not valid v2 conclusions. No causal fields are reconstructed. */
export function adaptV1SnapshotToV2(snapshot: SherlockInvestigation): SherlockInvestigationV2 {
  return { schema_version: "2.0.0", original_question: snapshot.case.observed_outcome, investigation_type: "diagnostic", observed_phenomenon: snapshot.case.observed_outcome, phenomenon_validation: "Legacy snapshot: phenomenon was asserted but validation cannot be reconstructed.", baseline: null, anomaly_status: "observed", causal_hypotheses: [], predictions: [], evidence: snapshot.case.evidence.map((item) => ({ ...item, legacy: true })), evidence_links: [], unexplained_observations: ["Legacy v1 fields cannot reconstruct causal predictions, detection coverage, or evidence links."], epistemic_status: "insufficient_evidence", leading_hypothesis: null, missing_evidence: ["A v2 causal protocol run is required."], next_discriminating_tests: ["Collect a baseline and prediction-linked observations with detection coverage."], semantic_audit: { passed: true, issues: ["Adapted from v1; numeric confidence and prime_suspect were intentionally ignored."], repair_attempts: 0 } };
}
