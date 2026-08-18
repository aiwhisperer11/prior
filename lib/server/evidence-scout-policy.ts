import type { CandidateTier } from "@/types/evidence-scout";

export const MAX_QUERIES_PER_ACTION = 2;
export const MAX_CANDIDATES_PER_ACTION = 5;

/**
 * Fail-closed by construction: search is disabled unless explicitly
 * enabled. Same shape as audit-storage.ts's resolveAuditStorageBackend:
 * unset/default is the safe state; an explicit non-default value is
 * honored, never silently downgraded. `npm test` never sets
 * ENABLE_EVIDENCE_SCOUT_SEARCH, so this is the actual, reliable mechanism
 * that keeps the suite live-call-free -- not a NODE_ENV check (`node --test`
 * does not set NODE_ENV=test, so a check against it would be a false
 * assurance, not a real one; deliberately not written here for that reason).
 * Test files that exercise performEvidenceScoutSearch directly additionally
 * always inject an explicit fake client, bypassing getOpenAIClient() entirely
 * regardless of this flag.
 */
export function isEvidenceScoutSearchEnabled(): boolean {
  return process.env.ENABLE_EVIDENCE_SCOUT_SEARCH === "1" || process.env.ENABLE_EVIDENCE_SCOUT_SEARCH === "true";
}

export function validateSearchRequestShape(input: {
  queries: unknown;
  maxCandidates: unknown;
  queryIntent: unknown;
  caseId: unknown;
  authorized: unknown;
}): { ok: true } | { ok: false; message: string } {
  if (input.authorized !== true) return { ok: false, message: "authorized must be true; search requires explicit user authorization" };
  if (typeof input.caseId !== "string" || !input.caseId.trim()) return { ok: false, message: "case_id is required" };
  if (typeof input.queryIntent !== "string" || !input.queryIntent.trim() || input.queryIntent.length > 500) {
    return { ok: false, message: "query_intent is required and must be 1-500 characters" };
  }
  if (!Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > MAX_QUERIES_PER_ACTION) {
    return { ok: false, message: `queries must contain between 1 and ${MAX_QUERIES_PER_ACTION} entries` };
  }
  if (!input.queries.every((q) => typeof q === "string" && q.trim().length > 0)) {
    return { ok: false, message: "every query must be a non-empty string" };
  }
  if (typeof input.maxCandidates !== "number" || !Number.isInteger(input.maxCandidates) || input.maxCandidates < 1 || input.maxCandidates > MAX_CANDIDATES_PER_ACTION) {
    return { ok: false, message: `max_candidates must be an integer between 1 and ${MAX_CANDIDATES_PER_ACTION}` };
  }
  return { ok: true };
}

/**
 * Source policy tiering (official/primary > institutional > reputable
 * secondary > other, labeled). Heuristic on the resolved publisher/domain --
 * deliberately conservative: anything not clearly matched falls to "other"
 * rather than being guessed into a higher tier.
 */
export function classifyTier(sourceUrl: string, publisher: string | null): CandidateTier {
  let host = "";
  try { host = new URL(sourceUrl).hostname.toLowerCase(); } catch { return "other"; }
  if (/\.gov$|\.gov\.[a-z]{2}$|\.mil$/.test(host)) return "official_primary";
  if (/status\.|\/incidents?\/|\/postmortem|\/blog\./.test(sourceUrl.toLowerCase()) && isLikelyVendorOwnDomain(host, publisher)) return "official_primary";
  if (/\.edu$|\.int$|wikipedia\.org$/.test(host)) return "institutional";
  return "reputable_secondary";
}

function isLikelyVendorOwnDomain(host: string, publisher: string | null): boolean {
  if (!publisher) return false;
  const normalizedPublisher = publisher.toLowerCase().replace(/[^a-z0-9]/g, "");
  // The registrable-domain label, not the subdomain: for "blog.cloudflare.com"
  // this must resolve to "cloudflare", not "blog" -- the second-to-last
  // label (before the TLD), after stripping a leading "www.".
  const labels = host.replace(/^www\./, "").split(".");
  const domainLabel = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  const normalizedHost = (domainLabel ?? "").replace(/[^a-z0-9]/g, "");
  return normalizedHost.length > 0 && (normalizedPublisher.includes(normalizedHost) || normalizedHost.includes(normalizedPublisher));
}
