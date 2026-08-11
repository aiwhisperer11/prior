import { parseSherlockInvestigation } from "@/lib/investigation-validation";
import type { SherlockInvestigation } from "@/types/sherlock";

export interface InvestigationApiResponse {
  investigation: SherlockInvestigation;
  precedents: Array<{ caseTitle: string; summary: string; isMock: boolean }>;
  storage: "cockroachdb" | "local-mock";
  memory_is_lead_not_evidence: true;
}

export type InvestigationApiResponseParseResult = { ok: true; response: InvestigationApiResponse } | { ok: false; errors: Array<{ instancePath: string; message: string }> };

export function parseInvestigationApiResponse(value: unknown): InvestigationApiResponseParseResult {
  if (value === null || typeof value !== "object") {
    const parsed = parseSherlockInvestigation(value);
    return parsed.ok ? { ok: false, errors: [{ instancePath: "/", message: "API response envelope is required" }] } : parsed;
  }
  const body = value as Record<string, unknown>;
  const parsed = parseSherlockInvestigation(body.investigation);
  if (!parsed.ok) return parsed;
  if (body.memory_is_lead_not_evidence !== true || (body.storage !== "cockroachdb" && body.storage !== "local-mock") || !Array.isArray(body.precedents)) return { ok: false, errors: [{ instancePath: "/", message: "invalid investigation API response envelope" }] };
  return { ok: true, response: { investigation: parsed.investigation, precedents: body.precedents.filter((lead): lead is { caseTitle: string; summary: string; isMock: boolean } => lead !== null && typeof lead === "object" && typeof (lead as Record<string, unknown>).caseTitle === "string" && typeof (lead as Record<string, unknown>).summary === "string" && typeof (lead as Record<string, unknown>).isMock === "boolean"), storage: body.storage, memory_is_lead_not_evidence: true } };
}
