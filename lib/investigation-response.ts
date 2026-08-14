import { parseSherlockInvestigation } from "@/lib/investigation-validation";
import { computeCaseFingerprint, hasCompleteIdentityFields, type CaseIdentityFields } from "@/lib/case-fingerprint";
import type { SherlockInvestigation } from "@/types/sherlock";
import type { EvidenceScoutResult } from "@/types/evidence-scout";

export interface PrecedentLeadView {
  caseId?: string;
  investigationId?: string;
  snapshotId?: string;
  sourceId?: string;
  domain?: string;
  observedOutcome?: string;
  expectedBehavior?: string;
  caseTitle: string;
  summary: string;
  isMock: boolean;
  similarityScore?: number | null;
  whyRelevant?: string;
}
export interface RelatedPrecedentView extends PrecedentLeadView { caseId: string; investigationId: string; snapshotId: string; sourceId: string; domain: string; }
export interface UnclassifiedLegacyMemoryView { caseTitle: string; summary: string; reason: string; }
export interface SuspectedDuplicateView { caseId: string; caseTitle: string; summary: string; reason: string; }
export interface CurrentCaseIdentity extends CaseIdentityFields { caseId: string; }

export const SUSPECTED_DUPLICATE_REASON = "different case_id with matching canonical case fingerprint";

export interface MemoryLineageView {
  snapshotId: string;
  investigationId: string;
  parentSnapshotId: string | null;
  sourceId: string;
  modelVersion: string;
  promptVersion: string;
  embeddingModel: string;
}

export interface InvestigationApiResponse {
  investigation: SherlockInvestigation;
  precedents: PrecedentLeadView[];
  unclassified_memory: UnclassifiedLegacyMemoryView[];
  suspected_duplicate_memory: SuspectedDuplicateView[];
  storage: "cockroachdb" | "local-mock";
  memory_is_lead_not_evidence: true;
  evidence_scout?: EvidenceScoutResult | null;
  /** Lineage of what was just persisted for this case_id; null if the store couldn't report it. */
  memory: MemoryLineageView | null;
}

export interface ClassifiedMemoryLeads {
  related: RelatedPrecedentView[];
  /** Same case_id as the current investigation — longitudinal continuity, never a precedent. */
  longitudinal: RelatedPrecedentView[];
  /** Different case_id, but its canonical case fingerprint matches the current case: a persisted duplicate, not an external precedent. */
  suspectedDuplicates: SuspectedDuplicateView[];
  unclassified: UnclassifiedLegacyMemoryView[];
}

/**
 * Presentation boundary: a case can never be its own external precedent
 * (longitudinal), and a different case_id whose canonical fingerprint
 * matches the current case is a suspected duplicate, never a related
 * precedent. Fingerprint identity is checked only after excluding same-case
 * leads and only when the candidate carries complete identity fields —
 * never derived from caseTitle/summary alone, embeddings, or
 * similarityScore.
 */
export function classifyMemoryLeads(leads: unknown[], currentCase: CurrentCaseIdentity): ClassifiedMemoryLeads {
  const related: RelatedPrecedentView[] = [];
  const longitudinal: RelatedPrecedentView[] = [];
  const suspectedDuplicates: SuspectedDuplicateView[] = [];
  const unclassified: UnclassifiedLegacyMemoryView[] = [];
  const currentFingerprint = computeCaseFingerprint(currentCase);
  for (const lead of leads) {
    if (!isPrecedentLead(lead)) continue;
    if (!lead.caseId || !lead.investigationId || !lead.snapshotId || !lead.sourceId || !lead.domain) {
      unclassified.push({ caseTitle: lead.caseTitle, summary: lead.summary, reason: "missing canonical case_id or provenance identifiers" });
      continue;
    }
    if (lead.caseId === currentCase.caseId) {
      longitudinal.push(lead as RelatedPrecedentView);
      continue;
    }
    if (hasCompleteIdentityFields(lead) && computeCaseFingerprint(lead) === currentFingerprint) {
      suspectedDuplicates.push({ caseId: lead.caseId, caseTitle: lead.caseTitle, summary: lead.summary, reason: SUSPECTED_DUPLICATE_REASON });
      continue;
    }
    related.push(lead as RelatedPrecedentView);
  }
  return { related, longitudinal, suspectedDuplicates, unclassified };
}

export type InvestigationApiResponseParseResult = { ok: true; response: InvestigationApiResponse } | { ok: false; errors: Array<{ instancePath: string; message: string }> };

function isPrecedentLead(lead: unknown): lead is PrecedentLeadView {
  if (lead === null || typeof lead !== "object") return false;
  const record = lead as Record<string, unknown>;
  return typeof record.caseTitle === "string" && typeof record.summary === "string" && typeof record.isMock === "boolean";
}

function isUnclassifiedLegacyMemoryView(item: unknown): item is UnclassifiedLegacyMemoryView {
  return item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).caseTitle === "string" && typeof (item as Record<string, unknown>).summary === "string" && typeof (item as Record<string, unknown>).reason === "string";
}

function isSuspectedDuplicateView(item: unknown): item is SuspectedDuplicateView {
  return item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).caseId === "string" && typeof (item as Record<string, unknown>).caseTitle === "string" && typeof (item as Record<string, unknown>).summary === "string" && typeof (item as Record<string, unknown>).reason === "string";
}

function parseMemory(value: unknown): MemoryLineageView | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.snapshotId !== "string" ||
    typeof record.investigationId !== "string" ||
    typeof record.sourceId !== "string" ||
    typeof record.modelVersion !== "string" ||
    typeof record.promptVersion !== "string" ||
    typeof record.embeddingModel !== "string"
  ) return null;
  return {
    snapshotId: record.snapshotId,
    investigationId: record.investigationId,
    parentSnapshotId: typeof record.parentSnapshotId === "string" ? record.parentSnapshotId : null,
    sourceId: record.sourceId,
    modelVersion: record.modelVersion,
    promptVersion: record.promptVersion,
    embeddingModel: record.embeddingModel,
  };
}

export function parseInvestigationApiResponse(value: unknown): InvestigationApiResponseParseResult {
  if (value === null || typeof value !== "object") {
    const parsed = parseSherlockInvestigation(value);
    return parsed.ok ? { ok: false, errors: [{ instancePath: "/", message: "API response envelope is required" }] } : parsed;
  }
  const body = value as Record<string, unknown>;
  const parsed = parseSherlockInvestigation(body.investigation);
  if (!parsed.ok) return parsed;
  if (body.memory_is_lead_not_evidence !== true || (body.storage !== "cockroachdb" && body.storage !== "local-mock") || !Array.isArray(body.precedents)) {
    return { ok: false, errors: [{ instancePath: "/", message: "invalid investigation API response envelope" }] };
  }
  const currentCase: CurrentCaseIdentity = {
    caseId: parsed.investigation.meta.case_id,
    caseTitle: parsed.investigation.meta.case_title,
    domain: parsed.investigation.meta.domain,
    observedOutcome: parsed.investigation.case.observed_outcome,
    expectedBehavior: parsed.investigation.case.expected_behavior,
  };
  const classified = classifyMemoryLeads(body.precedents, currentCase);
  return {
    ok: true,
    response: {
      investigation: parsed.investigation,
      precedents: classified.related,
      unclassified_memory: [...classified.unclassified, ...(Array.isArray(body.unclassified_memory) ? body.unclassified_memory.filter(isUnclassifiedLegacyMemoryView) : [])],
      suspected_duplicate_memory: [...classified.suspectedDuplicates, ...(Array.isArray(body.suspected_duplicate_memory) ? body.suspected_duplicate_memory.filter(isSuspectedDuplicateView) : [])],
      storage: body.storage,
      memory_is_lead_not_evidence: true,
      evidence_scout: body.evidence_scout as EvidenceScoutResult | null | undefined,
      memory: parseMemory(body.memory),
    },
  };
}
