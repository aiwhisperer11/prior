import { runSherlockInvestigation, type InvestigationEngineResult } from "@/lib/server/sherlock-engine";
import type { InvestigationIterationRequest, InvestigationRequest } from "@/types/sherlock";
import { CockroachDBMemoryStore, type EvidenceLinkedMemoryStore, type InvestigationMemoryStore, type LatestCaseSnapshot, type PrecedentLead } from "@/lib/server/memory-store";
import type { CandidateEvidenceLinkInput } from "@/lib/server/evidence-scout-store";
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
  saveSnapshotWithEvidenceLinks?: EvidenceLinkedMemoryStore["saveSnapshotWithEvidenceLinks"];
}

export async function runInvestigationFlow(
  request: InvestigationIterationRequest,
  store: InvestigationMemoryStore,
  run = runSherlockInvestigation,
  /** Point 5/6/8: only non-empty when this follow-up incorporated accepted_candidate_ids -- see prepareInvestigationRequest / the /api/investigate route. */
  candidateLinks: CandidateEvidenceLinkInput[] = [],
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
  // Point 13: no more retrieved_evidence_context / scout side-channel. The
  // only way Evidence Scout data ever reaches the investigator is as a
  // fully-accepted, server-constructed EvidenceItem in request.evidence,
  // going through the exact same path as any other evidence.
  const result = await run({ ...request, precedent_leads: precedents });
  const storage = store instanceof CockroachDBMemoryStore ? "cockroachdb" : "local-mock";
  let memory: LatestCaseSnapshot | null = null;

  if (result.ok) {
    if (candidateLinks.length > 0) {
      if (!semanticStore.saveSnapshotWithEvidenceLinks) {
        throw new Error("candidateLinks were supplied but the memory store does not implement saveSnapshotWithEvidenceLinks");
      }
      const linkResult = await semanticStore.saveSnapshotWithEvidenceLinks(
        { investigation: result.investigation, isMock: storage === "local-mock", retrievedMemory: classified },
        candidateLinks,
      );
      if (!linkResult.ok) {
        // Reuses the existing "validation" failure channel with a
        // distinguishing keyword rather than a new top-level result shape --
        // the snapshot was never persisted (the whole transaction rolled
        // back), so this is reported exactly like any other rejected
        // response: nothing reaches the API response or the UI.
        return {
          ok: false,
          kind: "validation",
          validationErrors: [{
            instancePath: "",
            schemaPath: "",
            keyword: "candidate_already_spent",
            message: `candidate ${linkResult.candidateId} was already incorporated as evidence in a different, concurrent follow-up`,
            params: { candidateId: linkResult.candidateId },
          }],
          rawResponses: result.rawResponses,
          precedents,
          unclassifiedMemory: classified.unclassified,
          suspectedDuplicateMemory: classified.suspectedDuplicates,
          storage,
          memory: null,
        };
      }
    } else {
      await store.save({ investigation: result.investigation, isMock: storage === "local-mock", retrievedMemory: classified });
    }
    memory = semanticStore.findLatestForCase ? await semanticStore.findLatestForCase(request.case_id) : null;
  }
  return { ...result, precedents, unclassifiedMemory: classified.unclassified, suspectedDuplicateMemory: classified.suspectedDuplicates, storage, memory };
}
