import gbpRubCase from "@/examples/gbp-rub-june-2023.json";
import type { EvidenceScoutCaseRequest, EvidenceScoutResult, RetrievedEvidence } from "@/types/evidence-scout";
import type { InvestigationRequest } from "@/types/sherlock";

export interface SourceAdapter { id: string; retrieve(caseId: string): Promise<RetrievedEvidence[]>; }
const retrievedAt = "2026-08-11T00:00:00.000Z";
const bankOfRussia = "https://www.cbr.ru/eng/currency_base/daily/";
const bankOfEngland = "https://www.bankofengland.co.uk/boeapps/database/Bank-Rate.asp";
class GbpRubFixtureAdapter implements SourceAdapter {
  id = "official-fixture-gbp-rub-june-2023";
  async retrieve(caseId: string): Promise<RetrievedEvidence[]> {
    if (caseId !== gbpRubCase.case_id) return [];
    const status = "fixture_pending_live_verification" as const;
    return [
      ["Bank of Russia official GBP reference rate", "101.10", "2023-06-23", bankOfRussia], ["Bank of Russia official GBP reference rate", "104.25", "2023-06-26", bankOfRussia], ["Bank of Russia official GBP reference rate", "106.00", "2023-06-27", bankOfRussia],
      ["Bank of Russia published FX reference-rate series", "published", "2023-06-23", bankOfRussia], ["Bank of Russia published FX reference-rate series", "published", "2023-06-26", bankOfRussia],
      ["Bank Rate", "5.00", "2023-06-22", bankOfEngland], ["Bank Rate", "5.00", "2023-06-27", bankOfEngland],
    ].map(([metric, value, observed_at, source_url]) => ({ origin: "sherlock_retrieval", metric, value, unit: metric === "Bank Rate" ? "percent" : metric.includes("reference") ? "RUB per GBP" : "status", observed_at, publisher: metric === "Bank Rate" ? "Bank of England" : "Bank of Russia", source_url, retrieved_at: retrievedAt, verification_status: status, supports: [], weakens: [] }));
  }
}
export class SourceCatalog { constructor(private readonly adapters: SourceAdapter[]) {} async retrieve(caseId: string) { return (await Promise.all(this.adapters.map((adapter) => adapter.retrieve(caseId)))).flat(); } }
const catalog = new SourceCatalog([new GbpRubFixtureAdapter()]);
export function isEvidenceScoutCaseRequest(value: unknown): value is EvidenceScoutCaseRequest { return value !== null && typeof value === "object" && (value as Record<string, unknown>).request_mode === "evidence_scout" && typeof (value as Record<string, unknown>).case_id === "string"; }
export async function scoutCase(scoutRequest: EvidenceScoutCaseRequest): Promise<{ request: InvestigationRequest; scout: EvidenceScoutResult }> {
  const caseId = scoutRequest.case_id;
  if (caseId !== gbpRubCase.case_id) throw new Error("Unknown Evidence Scout case");
  let retrieved_evidence: RetrievedEvidence[] = [];
  let missing_or_contradictory: RetrievedEvidence[] = [];
  try { retrieved_evidence = await catalog.retrieve(caseId); } catch { missing_or_contradictory = [{ origin: "sherlock_retrieval", metric: "Evidence Scout retrieval", value: null, unit: "unavailable", observed_at: "2023-06-23", publisher: "Evidence Scout", source_url: bankOfRussia, retrieved_at: retrievedAt, verification_status: "missing", supports: [], weakens: [] }]; }
  // Engine evidence is a transport projection of retrieved evidence; human_evidence remains empty.
  const engineEvidence = retrieved_evidence.map((item, index) => ({ id: `R${index + 1}`, label: item.metric, content: `${item.value} ${item.unit}; observed ${item.observed_at}; publisher ${item.publisher}.` }));
  if (!engineEvidence.length) engineEvidence.push({ id: "R0", label: "Evidence Scout retrieval unavailable", content: "No retrieved observation is available; treat this as missing data." });
  return { request: { case_id: scoutRequest.case_id, case_title: scoutRequest.case_title, domain: scoutRequest.domain, observed_outcome: scoutRequest.observed_outcome, expected_behavior: scoutRequest.expected_behavior, evidence: engineEvidence, user_hypotheses: ["A change in official reference-rate observations merits investigation, not causal attribution.", "A retrieval or publication gap could make the apparent move incomplete."] }, scout: { caseId, human_evidence: [], retrieved_evidence, inferences: [], missing_or_contradictory } };
}
