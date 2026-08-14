/**
 * Deterministic, representation-only case identity fingerprint. Answers one
 * question: does this candidate describe the same underlying real-world case
 * as the current investigation, under a different case_id? It is never used
 * to judge whether two different cases are merely similar — normalization
 * touches only representation (Unicode form, casing, whitespace, list
 * order), never meaning, so a genuinely different outcome or source always
 * changes the fingerprint.
 */
export interface CaseIdentityFields {
  caseTitle: string;
  domain: string;
  observedOutcome: string;
  expectedBehavior: string;
}

const FIELD_SEPARATOR = "␟";

function normalizeRepresentation(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const URL_TOKEN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s,;)"'<>]*)?/gi;

/** Case-preserving URL-like tokens embedded in free text, in original document order (duplicates kept). URL paths can be case-sensitive, so this is the form to display or link to. */
export function extractSourceUrlTokens(text: string): string[] {
  const matches = text.match(URL_TOKEN_PATTERN) ?? [];
  return matches.map((url) => url.replace(/[).,;:'"]+$/, ""));
}

/** Order-independent, case-folded: primary-source URLs embedded in free text, extracted so prose reordering or casing can't change the fingerprint. Not for display — see extractSourceUrlTokens for that. */
export function extractSourceUrls(text: string): string[] {
  return [...new Set(extractSourceUrlTokens(text).map((url) => url.toLowerCase()))].sort();
}

const TIME_TOKEN_PATTERN = /\b\d{4}-\d{2}-\d{2}(?:[ t]\d{2}:\d{2}(?::\d{2})?)?(?:\s?[a-z]{2,4}\b)?/gi;

/** Order-independent: ISO-like date/time tokens embedded in free text (the case's time window). */
export function extractTimeWindowTokens(text: string): string[] {
  const matches = text.match(TIME_TOKEN_PATTERN) ?? [];
  const normalized = matches.map((token) => token.toLowerCase().replace(/\s+/g, " ").trim());
  return [...new Set(normalized)].sort();
}

export function hasCompleteIdentityFields(fields: Partial<CaseIdentityFields>): fields is CaseIdentityFields {
  return Boolean(fields.caseTitle?.trim() && fields.domain?.trim() && fields.observedOutcome?.trim() && fields.expectedBehavior?.trim());
}

/**
 * Canonical fingerprint: title + domain + observed outcome + expected
 * behavior (the full substantive case description) plus the order-independent
 * time-window and source-URL tokens embedded in that text. Deliberately
 * excludes caseTitle-only or summary-only shortcuts, embeddings, and
 * similarity scores — none of those establish substantive case identity.
 */
export function computeCaseFingerprint(fields: CaseIdentityFields): string {
  const combinedText = `${fields.observedOutcome} ${fields.expectedBehavior}`;
  return [
    normalizeRepresentation(fields.caseTitle),
    normalizeRepresentation(fields.domain),
    normalizeRepresentation(fields.observedOutcome),
    normalizeRepresentation(fields.expectedBehavior),
    extractTimeWindowTokens(combinedText).join(FIELD_SEPARATOR),
    extractSourceUrls(combinedText).join(FIELD_SEPARATOR),
  ].join(FIELD_SEPARATOR);
}
