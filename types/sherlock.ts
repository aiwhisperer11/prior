// Source of truth: lib/investigation.schema.json.
// The Sherlock* declarations below mirror that complete schema. The legacy
// exports at the bottom exist only so the untouched pre-Block-2 route and UI
// continue to compile while they still consume lib/sherlock-schema.json.

import type { EvidenceProvenance } from "@/types/evidence-scout";

export type HypothesisStatus = "active" | "weakened" | "rejected" | "revived";
export type HypothesisOrigin = "user" | "sherlock";
export type AnomalySeverity = "low" | "medium" | "high";
export type MissingEvidenceCriticality = "critical" | "useful" | "noise";

export interface EvidenceItem {
  id: string;
  label: string;
  content: string;
  provided_in_iteration: number;
  /**
   * Server-owned, never inferred by the model (P1-P15 unchanged; this is not
   * a reasoning field). Required + nullable in the authoritative schema,
   * matching prime_suspect/killed_by's existing pattern -- the model always
   * echoes null (see the field's schema description), and
   * applyCanonicalCaseEnvelope's unconditional replacement of case.evidence
   * with the server's own request.evidence means the model's echo is
   * discarded regardless. A previous_snapshot persisted before this field
   * existed lacks the key entirely (not null, absent) on its evidence items
   * -- see lib/server/evidence-scout-legacy-schema.ts for the relaxed
   * validator that accepts that shape specifically for previous_snapshot,
   * never for a fresh model response.
   */
  provenance: EvidenceProvenance | null;
}

export interface InvestigationMeta {
  case_id: string;
  case_title: string;
  iteration: number;
  domain: string;
}

export interface InvestigationCase {
  observed_outcome: string;
  expected_behavior: string;
  evidence: EvidenceItem[];
}

export interface MatrixItem {
  id: string;
  description: string;
  evidence_ids: string[];
  significance: string;
  related_hypothesis_ids: string[];
}

export interface FalsificationExpectationMatrix {
  expected_present: MatrixItem[];
  unexpected_present: MatrixItem[];
  expected_absent: MatrixItem[];
  unexpected_absent: MatrixItem[];
}

export interface Anomaly {
  id: string;
  description: string;
  matrix_item_ids: string[];
  severity: AnomalySeverity;
  fully_explained: boolean;
  hypothesis_ids: string[];
}

export interface EvidenceLink {
  evidence_id: string;
  reason: string;
}

export interface SherlockHypothesis {
  id: string;
  statement: string;
  origin: HypothesisOrigin;
  status: HypothesisStatus;
  confidence: number;
  supported_by: EvidenceLink[];
  contradicted_by: EvidenceLink[];
  expected_but_absent_ids: string[];
  would_be_refuted_by: string;
  killed_by: string | null;
  resurrection_condition: string | null;
}

export interface MissingEvidence {
  id: string;
  description: string;
  criticality: MissingEvidenceCriticality;
  impact_if_found: string;
  related_hypothesis_ids: string[];
}

export interface PrimeSuspect {
  hypothesis_id: string;
  justification: string;
  condemning_datum: string;
  absolving_datum: string;
}

export type RootCauseStatus = "determined" | "undetermined";

export interface ExplainedScore {
  score: number;
  explanation: string;
}

export interface NextTestOutcome {
  observed_result: string;
  favors_hypothesis_id: string | null;
  weakens_hypothesis_id: string | null;
}

export interface NextTest {
  description: string;
  discriminates_between: string[];
  outcome_map: NextTestOutcome[];
  does_not_discriminate_from: string[];
}

export interface LearningUpdate {
  hypothesis_id: string;
  previous_confidence: number | null;
  new_confidence: number;
  previous_status: HypothesisStatus | null;
  new_status: HypothesisStatus;
  reason: string;
}

export interface Learning {
  is_baseline: boolean;
  summary: string;
  updates: LearningUpdate[];
}

export interface SherlockInvestigation {
  schema_version: string;
  meta: InvestigationMeta;
  case: InvestigationCase;
  expectation_matrix: FalsificationExpectationMatrix;
  anomalies: Anomaly[];
  hypotheses: SherlockHypothesis[];
  missing_evidence: MissingEvidence[];
  root_cause_status: RootCauseStatus;
  undetermined_explanation: string | null;
  prime_suspect: PrimeSuspect | null;
  coherence: ExplainedScore;
  open_case_index: ExplainedScore;
  next_test: NextTest;
  mirror_question: string;
  learning: Learning;
}

export interface InvestigationRequestEvidence {
  id: string;
  label: string;
  content: string;
}

export interface InvestigationRequest {
  case_id: string;
  case_title: string;
  domain: string;
  observed_outcome: string;
  expected_behavior: string;
  evidence: InvestigationRequestEvidence[];
  user_hypotheses?: string[];
}

export interface NewEvidenceInput {
  label: string;
  content: string;
}

export interface InvestigationIterationRequest extends InvestigationRequest {
  iteration: number;
  /** Canonical, server-numbered evidence (never the model's echo of it). */
  evidence: EvidenceItem[];
  previous_snapshot?: SherlockInvestigation;
  new_evidence?: EvidenceItem[];
  precedent_leads?: Array<{ caseId: string; caseTitle: string; domain: string; summary: string; isMock: boolean }>;
}

// Legacy compatibility for the old ACH UI. Remove in the UI migration.
export type Consistency = "consistent" | "inconsistent" | "neutral";

export interface Hypothesis {
  id: string;
  label: string;
  description: string;
  confidence: number;
}

export interface Expectation {
  id: string;
  statement: string;
}

export interface MatrixCell {
  hypothesisId: string;
  expectationId: string;
  consistency: Consistency;
  notes: string;
}

export interface InvestigationResult {
  question: string;
  summary: string;
  hypotheses: Hypothesis[];
  expectations: Expectation[];
  matrix: MatrixCell[];
  conclusion: string;
}
