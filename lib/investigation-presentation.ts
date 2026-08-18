import { extractSourceUrlTokens } from "@/lib/case-fingerprint";
import type { EvidenceItem, RootCauseStatus, SherlockInvestigation } from "@/types/sherlock";

/**
 * Read-models for the universal presentation slice.  They are deliberately
 * derived from the canonical investigation: old snapshots remain valid and
 * there is no second conclusion to persist or reconcile.
 */
export type EvidenceAssertionType = "observation" | "source_claim" | "measurement" | "document" | "expert_judgment" | "user_report";
export type SourceReliability = "high" | "medium" | "low" | "unknown";
export type VerificationStatus = "verified_as_published" | "citation_supported" | "corroborated" | "partially_verified" | "unverified";
export type CorroborationStatus = "independently_corroborated" | "single_source" | "contradicted" | "unassessed";
export type CaseRelevance = "direct" | "indirect" | "contextual";
export type EvidenceOrigin = "current_case" | "retrieved_memory" | "investigator_input" | "evidence_scout_accepted";

export interface EvidenceRecord {
  id: string;
  summary: string;
  assertion_type: EvidenceAssertionType;
  source: { source_id: string; name: string; url: string | null; published_at: string | null; captured_at: string | null };
  source_reliability: SourceReliability;
  verification_status: VerificationStatus;
  corroboration_status: CorroborationStatus;
  case_relevance: CaseRelevance;
  origin: EvidenceOrigin;
  supports_hypothesis_ids: string[];
  weakens_hypothesis_ids: string[];
}

export interface ExecutiveSummary {
  issue_overview: string;
  demonstrated_impact: string;
  causal_assessment: { root_cause_status: RootCauseStatus; prime_suspect_id: string | null; explanation: string };
  immediate_decision: string | null;
  /** Existing evidence IDs only; missing evidence remains in WALD and is not relabelled as evidence. */
  next_required_evidence_ids: string[];
}

function compact(text: string): string { return text.trim(); }

function sentences(text: string): string[] { return compact(text).split(/(?<=[.!?])\s+/).filter(Boolean); }

/** Separates the reported event from directly stated technical effects without adding business impact. */
function executiveNarrative(investigation: SherlockInvestigation): { overview: string; impact: string } {
  const reported = sentences(investigation.case.observed_outcome);
  const overview = reported[0] ?? investigation.meta.case_title;
  const impact = reported.slice(1).filter((sentence) => /(symptom|inconsistent|incomplete|missing|may not|delay|affected|span)/i.test(sentence));
  return {
    overview,
    impact: impact.join(" ") || "No separate impact has been demonstrated beyond the reported outcome.",
  };
}

function assertionType(item: EvidenceItem): EvidenceAssertionType {
  const label = item.label.toLowerCase();
  if (/(status update|statement|report|announcement)/.test(label)) return "source_claim";
  if (/(metric|measurement|log)/.test(label)) return "measurement";
  return "user_report";
}

/**
 * LEGACY FALLBACK, not a canonical provenance source. InvestigationCase.evidence
 * (lib/investigation.schema.json) has no per-item provenance field today, so
 * this infers a single case-wide source by reading expected_behavior — which
 * is a case-level narrative field, not structured evidence metadata, and was
 * never meant to carry provenance. It only replaces the strictly worse prior
 * heuristic (matching literal "status update" text in each item's own label,
 * which the model is free to paraphrase away). It is deliberately narrow: it
 * fires only when expected_behavior names exactly one source, and it then
 * applies that source to every evidence item uniformly, which is already an
 * approximation for any case with more than one real source.
 *
 * Do not extend this function to infer more provenance nuance from prose. The
 * correct fix is structural: give EvidenceItem (or the wire schema) a real
 * per-item provenance field (source_id/url/reliability) so the model reports
 * origin per evidence item, and retire this function once that lands.
 */
function singleDeclaredPublicSource(investigation: SherlockInvestigation): string | null {
  const tokens = extractSourceUrlTokens(investigation.case.expected_behavior);
  const distinct = new Set(tokens.map((token) => token.toLowerCase()));
  if (distinct.size !== 1) return null;
  const token = tokens[0]!;
  return /^https?:\/\//i.test(token) ? token : `https://${token}`;
}

/**
 * Real provenance (an accepted Evidence Scout candidate, item.provenance
 * non-null) always wins over the legacy inferred heuristic below -- this is
 * the gap normalizeEvidenceLedger's own prior doc comment called out as
 * needing "a real per-item provenance field", now closed structurally.
 * verification_status is carried through verbatim (never upgraded to
 * verified_as_published from anything less than the candidate itself
 * already established); corroboration_status stays "single_source" since
 * acceptance never implies independent corroboration on its own.
 */
function fromRealProvenance(item: EvidenceItem, supports: string[], weakens: string[]): EvidenceRecord {
  const provenance = item.provenance!;
  return {
    id: item.id,
    summary: compact(item.content),
    assertion_type: "source_claim",
    source: { source_id: item.id, name: provenance.publisher ?? provenance.document_title ?? item.label, url: provenance.source_url, published_at: provenance.publication_date, captured_at: provenance.retrieved_at },
    source_reliability: provenance.source_reliability,
    verification_status: provenance.verification_status,
    corroboration_status: "single_source",
    case_relevance: "direct",
    origin: "evidence_scout_accepted",
    supports_hypothesis_ids: supports,
    weakens_hypothesis_ids: weakens,
  };
}

/** Normalizes legacy evidence without upgrading a source claim to a verified observation. */
export function normalizeEvidenceLedger(investigation: SherlockInvestigation): EvidenceRecord[] {
  const declaredSource = singleDeclaredPublicSource(investigation);
  return investigation.case.evidence.map((item) => {
    const supports = investigation.hypotheses.filter((h) => h.supported_by.some((link) => link.evidence_id === item.id)).map((h) => h.id);
    const weakens = investigation.hypotheses.filter((h) => h.contradicted_by.some((link) => link.evidence_id === item.id)).map((h) => h.id);
    if (item.provenance) return fromRealProvenance(item, supports, weakens);
    const type = declaredSource ? "source_claim" : assertionType(item);
    return {
      id: item.id, summary: compact(item.content), assertion_type: type,
      source: { source_id: item.id, name: item.label, url: declaredSource, published_at: null, captured_at: null },
      source_reliability: declaredSource ? "high" : "unknown", verification_status: declaredSource ? "verified_as_published" : "unverified",
      corroboration_status: "unassessed", case_relevance: "direct", origin: "current_case",
      supports_hypothesis_ids: supports, weakens_hypothesis_ids: weakens,
    };
  });
}

export function deriveExecutiveSummary(investigation: SherlockInvestigation): ExecutiveSummary {
  const determined = investigation.root_cause_status === "determined" && investigation.prime_suspect;
  const causalExplanation = determined
    ? investigation.prime_suspect!.justification
    : (investigation.undetermined_explanation || "The available evidence does not determine a root cause.");
  const nextCritical = investigation.missing_evidence.filter((item) => item.criticality === "critical");
  const narrative = executiveNarrative(investigation);
  return {
    issue_overview: narrative.overview,
    demonstrated_impact: narrative.impact,
    causal_assessment: { root_cause_status: investigation.root_cause_status, prime_suspect_id: determined ? investigation.prime_suspect!.hypothesis_id : null, explanation: causalExplanation },
    immediate_decision: nextCritical.length ? `Obtain ${nextCritical.map((item) => item.id).join(", ")} before changing the causal assessment.` : null,
    next_required_evidence_ids: [],
  };
}

/** IDs supporting the executive causal statement, kept separate from the full ledger. */
export function executiveEvidenceIds(investigation: SherlockInvestigation): string[] {
  if (investigation.prime_suspect) {
    const hypothesis = investigation.hypotheses.find((item) => item.id === investigation.prime_suspect?.hypothesis_id);
    return hypothesis ? [...new Set([...hypothesis.supported_by, ...hypothesis.contradicted_by].map((link) => link.evidence_id))] : [];
  }
  return [...new Set(investigation.expectation_matrix.expected_absent.flatMap((item) => item.evidence_ids))];
}
