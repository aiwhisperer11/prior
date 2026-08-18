// Governed Evidence Scout: web-search-sourced candidates that require
// explicit human acceptance before becoming canonical evidence. A
// source_candidate is never an EvidenceItem — see EvidenceProvenance below
// for the shape acceptance produces, and lib/server/evidence-scout-store.ts
// for the state machine (missing_evidence -> search_plan -> source_candidate
// -> accepted_evidence | rejected_candidate -> reinvestigation) this file's
// types represent snapshots of.

export type EvidenceScoutActionState = "authorized" | "searching" | "completed" | "failed";
export type SourceCandidateState = "pending" | "accepted" | "rejected";
export type CandidateTier = "official_primary" | "institutional" | "reputable_secondary" | "other";

/**
 * Verification ladder. source_located: a URL/publisher was found, no
 * confirmed claim linkage. citation_supported: a claim_summary and fragment
 * accompany the citation, but the excerpt is not confirmed literal.
 * verified_as_published: cited_text is a literal, confirmed excerpt. Only
 * the latter two are ever eligible to become an EvidenceItem — see
 * EligibleCandidateVerificationStatus.
 */
export type CandidateVerificationStatus = "source_located" | "citation_supported" | "verified_as_published";
export type SourceReliability = "high" | "medium" | "low" | "unknown";

/** Never a raw error message or stack -- see evidence_scout_action.failure_code (migration 004). */
export type EvidenceScoutFailureCode =
  | "search_timeout"
  | "search_api_error"
  | "invalid_response_shape"
  | "daily_budget_exceeded"
  | "max_attempts_exceeded"
  | "dispatch_failed"
  | "unknown_error";

export interface EvidenceScoutAction {
  action_id: string;
  case_id: string;
  investigation_id: string | null;
  missing_evidence_id: string | null;
  query_intent: string;
  queries: string[];
  max_candidates: number;
  allowed_domains: string[] | null;
  state: EvidenceScoutActionState;
  authorized_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_code: EvidenceScoutFailureCode | null;
  search_call_count: number;
  attempt_count: number;
}

export interface SourceCandidate {
  candidate_id: string;
  action_id: string;
  case_id: string;
  query: string;
  publisher: string | null;
  document_title: string | null;
  source_url: string;
  claim_summary: string;
  cited_text: string | null;
  fragment: string | null;
  tier: CandidateTier;
  verification_status: CandidateVerificationStatus;
  source_reliability: SourceReliability;
  retrieved_at: string;
  state: SourceCandidateState;
  decided_at: string | null;
  /** Punto 8 (link durable candidate -> evidence_id -> snapshot/iteration). All three rise and fall together; set only after a follow-up that included this candidate actually persists. */
  evidence_id: string | null;
  snapshot_id: string | null;
  iteration: number | null;
}

export interface EvidenceScoutActionWithCandidates extends EvidenceScoutAction {
  candidates: SourceCandidate[];
}

/** source_located is structurally excluded: never eligible to become an EvidenceItem (point 8). */
export type EligibleCandidateVerificationStatus = Exclude<CandidateVerificationStatus, "source_located">;

/**
 * What accepting an eligible candidate produces, server-owned throughout.
 * Field names/types are aligned 1:1 with the evidence_scout_candidate
 * columns they are read from (migration 004) -- see the mapping table in
 * docs/evidence-scout.md. Never constructed from anything the client sends;
 * always resolved server-side from durable candidate rows.
 */
export interface EvidenceProvenance {
  evidence_type: "official_publication" | "institutional_documentation" | "reputable_secondary" | "other";
  publisher: string | null;
  document_title: string | null;
  source_url: string;
  publication_date: string | null;
  retrieved_at: string;
  fragment: string;
  cited_text: string | null;
  claim_summary: string;
  human_accepted_at: string;
  verification_status: EligibleCandidateVerificationStatus;
  source_reliability: SourceReliability;
  search_lineage: { action_id: string; query: string; candidate_id: string };
}

// --- API request/response shapes -------------------------------------------

export interface EvidenceScoutSearchRequest {
  case_id: string;
  missing_evidence_id?: string | null;
  query_intent: string;
  queries: string[];
  max_candidates: number;
  allowed_domains?: string[];
  authorized: true;
}

export interface EvidenceScoutSearchAccepted {
  action_id: string;
  state: EvidenceScoutActionState;
}

export type EvidenceScoutCandidateDecision = "accept" | "reject";

export interface EvidenceScoutCandidateDecisionRequest {
  decision: EvidenceScoutCandidateDecision;
}

export interface EvidenceScoutCandidateDecisionResponse {
  candidate_id: string;
  state: SourceCandidateState;
  decided_at: string | null;
}
