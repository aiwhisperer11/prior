export type EvidenceVerificationStatus = "fixture_pending_live_verification" | "verified" | "missing";
export interface RetrievedEvidence {
  origin: "sherlock_retrieval";
  metric: string;
  value: number | string | null;
  unit: string;
  observed_at: string;
  publisher: string;
  source_url: string;
  retrieved_at: string;
  verification_status: EvidenceVerificationStatus;
  supports: string[];
  weakens: string[];
}
export interface EvidenceScoutResult {
  caseId: string;
  human_evidence: [];
  retrieved_evidence: RetrievedEvidence[];
  inferences: [];
  missing_or_contradictory: RetrievedEvidence[];
}
export interface EvidenceScoutCaseRequest {
  request_mode: "evidence_scout";
  case_id: string;
  case_title: string;
  domain: string;
  observed_outcome: string;
  expected_behavior: string;
}
