import { getOpenAIClient } from "@/lib/openai";
import { classifyTier } from "@/lib/server/evidence-scout-policy";
import type { EvidenceScoutCandidateStore, NewCandidateInput } from "@/lib/server/evidence-scout-store";
import type { CandidateVerificationStatus, EvidenceScoutFailureCode } from "@/types/evidence-scout";

/**
 * Separate, isolated model call from the investigator (lib/server/sherlock-engine.ts):
 * a different SDK method (responses.create vs chat.completions.create), a
 * different exported model constant, never invoked from the same function or
 * interleaved with an investigator call. This is the mechanism that prevents
 * a web-search response from ever being mistaken for or merged into the
 * investigator's reasoning.
 */
export const EVIDENCE_SCOUT_SEARCH_MODEL = "gpt-5.6-terra";

/** Minimal surface this module actually calls -- lets tests inject a fake without depending on the full OpenAI SDK type. */
export interface WebSearchAnnotation {
  type: "url_citation" | string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}
export interface WebSearchOutputTextContent {
  type: "output_text";
  text: string;
  annotations: WebSearchAnnotation[];
}
export interface WebSearchMessageOutput {
  type: "message";
  content: Array<WebSearchOutputTextContent | { type: string }>;
}
export interface WebSearchCallOutput {
  type: "web_search_call";
  id: string;
  status: string;
}
export type WebSearchResponseOutputItem = WebSearchMessageOutput | WebSearchCallOutput | { type: string };
export interface WebSearchResponse {
  output: WebSearchResponseOutputItem[];
}
export interface WebSearchClient {
  responses: {
    create(params: {
      model: string;
      input: string;
      tools: Array<{ type: "web_search"; filters?: { allowed_domains?: string[] } }>;
    }): Promise<WebSearchResponse>;
  };
}

interface ExtractedCandidate {
  sourceUrl: string;
  title: string | null;
  claimSummary: string;
  citedText: string | null;
  fragment: string | null;
}

const QUOTE_PATTERN = /^["“][\s\S]*["”]$/;

/**
 * A url_citation alone is never sufficient for verified_as_published (point
 * 3): it only proves the model attributed a span of ITS OWN generated text
 * to a URL, not that the span is a verbatim quote from the source. cited_text
 * is populated only when the annotated span is explicitly quote-delimited in
 * the model's own text -- a conservative, structural signal, never a
 * semantic judgment about whether the claim is "probably" accurate.
 */
function extractCandidatesFromOutput(output: WebSearchResponseOutputItem[]): ExtractedCandidate[] {
  const candidates: ExtractedCandidate[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const content of (item as WebSearchMessageOutput).content) {
      if (content.type !== "output_text") continue;
      const { text, annotations } = content as WebSearchOutputTextContent;
      for (const annotation of annotations) {
        if (annotation.type !== "url_citation" || !annotation.url) continue;
        const start = annotation.start_index ?? 0;
        const end = annotation.end_index ?? start;
        const span = text.slice(start, end).trim();
        const quoted = QUOTE_PATTERN.test(span) ? span.slice(1, -1).trim() : null;
        candidates.push({
          sourceUrl: annotation.url,
          title: annotation.title ?? null,
          claimSummary: span || text.slice(0, 300).trim(),
          citedText: quoted,
          fragment: span || null,
        });
      }
    }
  }
  return candidates;
}

function classifyVerification(candidate: ExtractedCandidate): CandidateVerificationStatus {
  if (candidate.citedText) return "verified_as_published";
  if (candidate.fragment) return "citation_supported";
  return "source_located";
}

function toNewCandidateInput(candidate: ExtractedCandidate, query: string): NewCandidateInput {
  const verificationStatus = classifyVerification(candidate);
  return {
    query,
    publisher: candidate.title,
    documentTitle: candidate.title,
    sourceUrl: candidate.sourceUrl,
    claimSummary: candidate.claimSummary.slice(0, 1000),
    citedText: candidate.citedText ? candidate.citedText.slice(0, 2000) : null,
    fragment: candidate.fragment ? candidate.fragment.slice(0, 2000) : null,
    publicationDate: null,
    tier: classifyTier(candidate.sourceUrl, candidate.title),
    verificationStatus,
    sourceReliability: verificationStatus === "verified_as_published" ? "high" : verificationStatus === "citation_supported" ? "medium" : "unknown",
  };
}

function buildSearchPrompt(queryIntent: string, query: string): string {
  return `You are a source-finding assistant for a governed evidence workflow. You do not draw causal conclusions and you are not the investigator.

Find sources for exactly this gap: ${queryIntent}

Search query: ${query}

Rules:
- Prefer an official/primary source (the organization's own status page, postmortem, or press release) over secondary coverage.
- When you can identify a literal sentence or phrase from the source that directly addresses the gap, quote it verbatim, wrapped in double quotes, and cite it.
- If you cannot find a literal quotable sentence, describe in your own words what the source appears to say, and cite it -- do not fabricate a quote.
- If you find nothing relevant, say so plainly. Do not invent a URL or a claim to fill the gap.
- Never claim the absence of a search result proves or disproves anything about the case.`;
}

export interface PerformSearchDependencies {
  store: EvidenceScoutCandidateStore;
  client?: WebSearchClient;
}

/**
 * The core search logic, shared verbatim by the Local executor (dev/test)
 * and the Lambda handler (production) -- see lib/server/evidence-scout-executor.ts
 * and lib/server/evidence-scout-lambda-handler.ts. Never fire-and-forget:
 * callers always await this to completion.
 */
export async function performEvidenceScoutSearch(actionId: string, deps: PerformSearchDependencies): Promise<void> {
  const { store } = deps;
  const client = deps.client ?? (getOpenAIClient() as unknown as WebSearchClient);

  const claim = await store.claimAction(actionId);
  if (!claim.claimed || !claim.action) return; // duplicate delivery / already claimed / attempts exhausted -- silent no-op, never an error

  const action = claim.action;
  let searchCallCount = 0;
  let failureCode: EvidenceScoutFailureCode | null = null;
  const allCandidates: NewCandidateInput[] = [];

  try {
    for (const query of action.queries) {
      if (searchCallCount >= action.queries.length) break; // hard cap: never more calls than authorized queries
      searchCallCount += 1;
      const response = await client.responses.create({
        model: EVIDENCE_SCOUT_SEARCH_MODEL,
        input: buildSearchPrompt(action.query_intent, query),
        tools: [{ type: "web_search", ...(action.allowed_domains ? { filters: { allowed_domains: action.allowed_domains } } : {}) }],
      });
      const extracted = extractCandidatesFromOutput(response.output);
      for (const candidate of extracted) {
        if (allCandidates.length >= action.max_candidates) break;
        allCandidates.push(toNewCandidateInput(candidate, query));
      }
      // Point: "detener al encontrar fuente primaria suficiente" -- stop
      // issuing further authorized queries once an official/primary,
      // verified_as_published candidate has been found.
      if (allCandidates.some((c) => c.tier === "official_primary" && c.verificationStatus === "verified_as_published")) break;
    }
  } catch {
    failureCode = "search_api_error";
  }

  if (failureCode) {
    await store.failAction(actionId, claim.workerId, failureCode);
    return;
  }

  const completed = await store.completeAction(actionId, claim.workerId, allCandidates, searchCallCount);
  if (!completed.ok) return; // lease was reassigned to a newer attempt; that attempt owns the result now
}
