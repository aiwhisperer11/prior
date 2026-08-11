import { runSherlockInvestigation, type InvestigationEngineResult } from "@/lib/server/sherlock-engine";
import type { InvestigationIterationRequest } from "@/types/sherlock";
import { CockroachDBMemoryStore, type InvestigationMemoryStore, type PrecedentLead } from "@/lib/server/memory-store";

export type InvestigationFlowResult = InvestigationEngineResult & { precedents: PrecedentLead[]; storage: "cockroachdb" | "local-mock" };

export async function runInvestigationFlow(
  request: InvestigationIterationRequest,
  store: InvestigationMemoryStore,
  run = runSherlockInvestigation,
): Promise<InvestigationFlowResult> {
  const precedents = await store.findPrecedents(request.domain, request.case_id);
  const result = await run({ ...request, precedent_leads: precedents });
  const storage = store instanceof CockroachDBMemoryStore ? "cockroachdb" : "local-mock";
  if (result.ok) await store.save({ investigation: result.investigation, isMock: storage === "local-mock" });
  return { ...result, precedents, storage };
}
