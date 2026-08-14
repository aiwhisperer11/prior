import { runSherlockInvestigation, type InvestigationEngineResult } from "@/lib/server/sherlock-engine";
import type { InvestigationIterationRequest, InvestigationRequest } from "@/types/sherlock";
import { CockroachDBMemoryStore, type InvestigationMemoryStore, type LatestCaseSnapshot, type PrecedentLead } from "@/lib/server/memory-store";
import type { EvidenceScoutResult } from "@/types/evidence-scout";
import { classifyMemoryLeads, type CurrentCaseIdentity } from "@/lib/investigation-response";

export type InvestigationFlowResult = InvestigationEngineResult & {
  precedents: PrecedentLead[];
  storage: "cockroachdb" | "local-mock";
  /** Lineage of what was just persisted (investigation_id, source_id, model/prompt version, parent). Null when the store doesn't support it (e.g. a test double) or nothing was saved. */
  memory: LatestCaseSnapshot | null;
  unclassifiedMemory: Array<{ caseTitle: string; summary: string; reason: string }>;
  /** Different case_id, but the canonical case fingerprint matches this investigation: a persisted duplicate, excluded from precedent retrieval like a self-precedent. */
  suspectedDuplicateMemory: Array<{ caseId: string; caseTitle: string; summary: string; reason: string }>;
};

/**
 * Optional capabilities beyond the base InvestigationMemoryStore contract.
 * Detected via duck typing so callers that pass a plain findPrecedents/save
 * store (e.g. existing tests) keep working unchanged, while the real
 * getMemoryStore() (which always implements SemanticMemoryStore) gets real
 * semantic retrieval and lineage automatically.
 */
interface SemanticCapableStore extends InvestigationMemoryStore {
  findSemanticPrecedents?(request: InvestigationRequest, excludeCaseId: string, limit?: number): Promise<PrecedentLead[]>;
  findLatestForCase?(caseId: string): Promise<LatestCaseSnapshot | null>;
}

export async function runInvestigationFlow(
  request: InvestigationIterationRequest,
  store: InvestigationMemoryStore,
  run = runSherlockInvestigation,
  scout?: EvidenceScoutResult,
): Promise<InvestigationFlowResult> {
  const semanticStore = store as SemanticCapableStore;
  const retrievedPrecedents = semanticStore.findSemanticPrecedents
    ? await semanticStore.findSemanticPrecedents(request, request.case_id)
    : await store.findPrecedents(request.domain, request.case_id);
  // Store implementations and serialized retrieval responses are untrusted at
  // this boundary. Same-case history is longitudinal memory, never a related
  // precedent, even if an adapter returned it erroneously — and a different
  // case_id whose canonical fingerprint matches this case is a persisted
  // duplicate, not a genuine external precedent.
  const currentCase: CurrentCaseIdentity = {
    caseId: request.case_id,
    caseTitle: request.case_title,
    domain: request.domain,
    observedOutcome: request.observed_outcome,
    expectedBehavior: request.expected_behavior,
  };
  const classified = classifyMemoryLeads(retrievedPrecedents, currentCase);
  const precedents = classified.related;
  const result = await run({ ...request, precedent_leads: precedents, retrieved_evidence_context: scout?.retrieved_evidence });
  const storage = store instanceof CockroachDBMemoryStore ? "cockroachdb" : "local-mock";
  let memory: LatestCaseSnapshot | null = null;
  if (result.ok) {
    await store.save({ investigation: result.investigation, isMock: storage === "local-mock" });
    memory = semanticStore.findLatestForCase ? await semanticStore.findLatestForCase(request.case_id) : null;
  }
  return { ...result, precedents, unclassifiedMemory: classified.unclassified, suspectedDuplicateMemory: classified.suspectedDuplicates, storage, memory };
}
