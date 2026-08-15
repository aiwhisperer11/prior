import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import type OpenAI from "openai";

import investigationSchema from "@/lib/investigation.schema.json";
import { getOpenAIClient } from "@/lib/openai";
import {
  invalidExpectedButAbsentIds,
  ungroundedUnexpectedAbsentIds,
  unknownEvidenceIds,
} from "@/lib/server/investigation-assertions-shared";
import { buildInvestigationUserMessage, SYSTEM_PROMPT } from "@/lib/sherlock-prompt";
import { OPENAI_INVESTIGATION_WIRE_SCHEMA } from "@/lib/wire-schema";
import type {
  EvidenceItem,
  InvestigationIterationRequest,
  InvestigationRequest,
  InvestigationRequestEvidence,
  NewEvidenceInput,
  SherlockInvestigation,
} from "@/types/sherlock";

/** Server-only investigation execution shared by the API route and live evaluator. */
export const OPENAI_MODEL = "gpt-5.6-terra";

export interface ValidationErrorResponse {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string | undefined;
  params: Record<string, unknown>;
}

export type InvestigationEngineResult =
  | {
      ok: true;
      investigation: SherlockInvestigation;
      rawResponses: string[];
    }
  | {
      ok: false;
      kind: "openai" | "validation";
      validationErrors: ValidationErrorResponse[];
      rawResponses: string[];
    };

export type InvestigationPreparationResult =
  | { ok: true; request: InvestigationIterationRequest }
  | { ok: false; message: string };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateInvestigation = ajv.compile(investigationSchema);

function formatValidationErrors(errors: ErrorObject[] | null | undefined): ValidationErrorResponse[] {
  return (errors ?? []).map(({ instancePath, schemaPath, keyword, message, params }) => ({
    instancePath,
    schemaPath,
    keyword,
    message,
    params,
  }));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSherlockInvestigation(value: unknown): value is SherlockInvestigation {
  return validateInvestigation(value) as boolean;
}

export function isInvestigationRequest(value: unknown): value is InvestigationRequest {
  if (value === null || typeof value !== "object") return false;

  const body = value as Record<string, unknown>;
  const hasValidEvidence =
    Array.isArray(body.evidence) &&
    body.evidence.length > 0 &&
    body.evidence.every((item) => {
      if (item === null || typeof item !== "object") return false;
      const evidence = item as Record<string, unknown>;
      return (
        isNonEmptyString(evidence.id) &&
        isNonEmptyString(evidence.label) &&
        isNonEmptyString(evidence.content)
      );
    });
  const hasValidUserHypotheses =
    body.user_hypotheses === undefined ||
    (Array.isArray(body.user_hypotheses) && body.user_hypotheses.every(isNonEmptyString));

  return (
    isNonEmptyString(body.case_id) &&
    isNonEmptyString(body.case_title) &&
    isNonEmptyString(body.domain) &&
    isNonEmptyString(body.observed_outcome) &&
    isNonEmptyString(body.expected_behavior) &&
    hasValidEvidence &&
    hasValidUserHypotheses
  );
}

function isNewEvidence(value: unknown): value is NewEvidenceInput[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => {
    if (item === null || typeof item !== "object") return false;
    const evidence = item as Record<string, unknown>;
    return isNonEmptyString(evidence.label) && isNonEmptyString(evidence.content);
  });
}

function nextEvidenceNumber(previousSnapshot: SherlockInvestigation): number {
  return previousSnapshot.case.evidence.reduce((maximum, evidence) => {
    const match = /^E(\d+)$/.exec(evidence.id);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
}

/**
 * Normalizes any caller-supplied evidence item to the canonical EvidenceItem
 * shape. Preserves an existing provided_in_iteration (prior evidence carried
 * forward into a follow-up must keep the iteration it actually entered on);
 * stamps fallbackIteration only when the wire input never carried one, which
 * is the normal case for a fresh baseline request.
 */
function toCanonicalEvidenceItem(evidence: InvestigationRequestEvidence | EvidenceItem, fallbackIteration: number): EvidenceItem {
  const existing = (evidence as Partial<EvidenceItem>).provided_in_iteration;
  return {
    id: evidence.id,
    label: evidence.label,
    content: evidence.content,
    provided_in_iteration: typeof existing === "number" ? existing : fallbackIteration,
  };
}

/** Validates and normalizes either a baseline request or an iteration request. */
export function prepareInvestigationRequest(value: unknown): InvestigationPreparationResult {
  if (value !== null && typeof value === "object") {
    const body = value as Record<string, unknown>;
    if (body.previous_snapshot !== undefined) {
      if (!isSherlockInvestigation(body.previous_snapshot)) {
        return { ok: false, message: "previous_snapshot must be a valid Sherlock investigation" };
      }
      if (
        !isNonEmptyString(body.previous_snapshot.case.observed_outcome) ||
        !isNonEmptyString(body.previous_snapshot.case.expected_behavior) ||
        body.previous_snapshot.case.evidence.length === 0
      ) {
        return { ok: false, message: "previous_snapshot requires observed_outcome, expected_behavior, and at least one evidence item" };
      }
      if (!isNewEvidence(body.new_evidence)) {
        return { ok: false, message: "new_evidence must contain at least one label and content pair" };
      }

      const previousSnapshot = body.previous_snapshot;
      const iteration = previousSnapshot.meta.iteration + 1;
      const firstEvidenceNumber = nextEvidenceNumber(previousSnapshot);
      const newEvidence = body.new_evidence.map((evidence, index) => ({
        id: `E${firstEvidenceNumber + index}`,
        label: evidence.label,
        content: evidence.content,
        provided_in_iteration: iteration,
      }));

      return {
        ok: true,
        request: {
          case_id: previousSnapshot.meta.case_id,
          case_title: previousSnapshot.meta.case_title,
          domain: previousSnapshot.meta.domain,
          observed_outcome: previousSnapshot.case.observed_outcome,
          expected_behavior: previousSnapshot.case.expected_behavior,
          evidence: [...previousSnapshot.case.evidence, ...newEvidence],
          iteration,
          previous_snapshot: previousSnapshot,
          new_evidence: newEvidence,
        },
      };
    }
  }

  if (!isInvestigationRequest(value)) {
    return {
      ok: false,
      message: "request requires observed_outcome, expected_behavior, and at least one evidence item with id, label, and content",
    };
  }

  return {
    ok: true,
    request: { ...value, iteration: 1, evidence: value.evidence.map((evidence) => toCanonicalEvidenceItem(evidence, 1)) },
  };
}

function parseModelResponse(content: string): unknown {
  return JSON.parse(content) as unknown;
}

/**
 * The Case Envelope boundary. The model is authoritative only for derived
 * reasoning (matrix, anomalies, hypotheses, evidence-link reasons, missing
 * evidence, next test, causal assessment, learning); everything that
 * identifies the case itself is owned by the server and always comes from
 * the prepared request, never from the model's echo of it. Applied exactly
 * once, immediately after a model response validates against the schema —
 * this is the single point every consumer (persistence, the API response,
 * and the UI) reads from, so there is nowhere downstream left for the
 * model's echo to leak back in.
 */
function applyCanonicalCaseEnvelope(
  investigation: SherlockInvestigation,
  request: InvestigationIterationRequest,
): SherlockInvestigation {
  return {
    ...investigation,
    meta: {
      case_id: request.case_id,
      case_title: request.case_title,
      domain: request.domain,
      iteration: request.iteration,
    },
    case: {
      observed_outcome: request.observed_outcome,
      expected_behavior: request.expected_behavior,
      evidence: request.evidence,
    },
  };
}

/**
 * Semantic integrity gate applied after the Case Envelope boundary, on the
 * reasoning the model remains authoritative for. Two independent checks:
 * every evidence id referenced anywhere (matrix, hypothesis links, killed_by)
 * must resolve against the canonical evidence set, and every
 * expected_but_absent_id must resolve to a real, correctly-linked
 * unexpected_absent item that is itself grounded in evidence that was
 * actually checked — the structural proxy for P3's distinction between a
 * demonstrated absence and data that was simply never available to check.
 */
function semanticIntegrityErrorsFor(
  request: InvestigationIterationRequest,
  investigation: SherlockInvestigation,
): ValidationErrorResponse[] {
  const errors: ValidationErrorResponse[] = [];

  const dangling = unknownEvidenceIds(request, investigation);
  if (dangling.length > 0) {
    errors.push({
      instancePath: "",
      schemaPath: "",
      keyword: "evidence_reference",
      message: `Model referenced evidence id(s) not present in the canonical evidence set: ${dangling.join(", ")}`,
      params: { danglingEvidenceIds: dangling },
    });
  }

  const invalidExpectedButAbsent = invalidExpectedButAbsentIds(investigation);
  if (invalidExpectedButAbsent.length > 0) {
    errors.push({
      instancePath: "",
      schemaPath: "",
      keyword: "expected_but_absent_reference",
      message: invalidExpectedButAbsent
        .map(({ hypothesisId, id }) => `${hypothesisId}.expected_but_absent_ids references ${id}, which is not an expectation_matrix.unexpected_absent item naming ${hypothesisId} in related_hypothesis_ids`)
        .join("; "),
      params: { invalidExpectedButAbsent },
    });
  }

  const ungrounded = ungroundedUnexpectedAbsentIds(investigation);
  if (ungrounded.length > 0) {
    errors.push({
      instancePath: "",
      schemaPath: "",
      keyword: "ungrounded_unexpected_absent",
      message: `expectation_matrix.unexpected_absent item(s) cite no evidence_ids, so they cannot demonstrate an absence: ${ungrounded.join(", ")}. Data that was never available to check belongs in missing_evidence, not unexpected_absent.`,
      params: { ungroundedUnexpectedAbsentIds: ungrounded },
    });
  }

  return errors;
}

/**
 * Calls the model with the canonical prompt and wire schema, then validates
 * every parsed response against the full authoritative schema. A malformed or
 * invalid response receives exactly one retry.
 */
export async function runSherlockInvestigation(
  request: InvestigationIterationRequest | InvestigationRequest,
  client: OpenAI = getOpenAIClient(),
): Promise<InvestigationEngineResult> {
  // Defensively re-derived even when the caller already passed an
  // InvestigationIterationRequest: runSherlockInvestigation is directly
  // callable (eval scripts, tests) without going through
  // prepareInvestigationRequest, and the Case Envelope must be canonical
  // regardless of entry point.
  const iterationNumber = "iteration" in request ? request.iteration : 1;
  const preparedRequest: InvestigationIterationRequest = {
    ...request,
    iteration: iterationNumber,
    evidence: request.evidence.map((evidence) => toCanonicalEvidenceItem(evidence, iterationNumber)),
  };
  const rawResponses: string[] = [];
  let validationErrors: ValidationErrorResponse[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let content: string | null | undefined;

    try {
      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildInvestigationUserMessage(preparedRequest) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: OPENAI_INVESTIGATION_WIRE_SCHEMA,
        },
      });
      content = completion.choices[0]?.message?.content;
    } catch {
      return { ok: false, kind: "openai", validationErrors: [], rawResponses };
    }

    if (!content) {
      validationErrors = [
        {
          instancePath: "",
          schemaPath: "",
          keyword: "response",
          message: "Model returned an empty response",
          params: {},
        },
      ];
      continue;
    }

    rawResponses.push(content);

    let candidate: unknown;
    try {
      candidate = parseModelResponse(content);
    } catch {
      validationErrors = [
        {
          instancePath: "",
          schemaPath: "",
          keyword: "parse",
          message: "Model returned invalid JSON",
          params: {},
        },
      ];
      continue;
    }

    if (isSherlockInvestigation(candidate)) {
      const canonical = applyCanonicalCaseEnvelope(candidate, preparedRequest);

      // The envelope substitution must still produce a schema-valid
      // investigation, every evidence id the model's reasoning refers to
      // (expectation_matrix, supported_by/contradicted_by, killed_by) must
      // resolve against the canonical evidence set, and every
      // expected_but_absent_id must resolve to a real, correctly-linked
      // unexpected_absent item that is itself grounded in evidence that was
      // actually checked (P3) — never an id the model invented, renumbered,
      // copied from a prior iteration, or borrowed from missing_evidence.
      // Any failure is treated exactly like a malformed response: one
      // retry, then rejection. Nothing unvalidated ever reaches
      // persistence, the API response, or the UI.
      if (!isSherlockInvestigation(canonical)) {
        validationErrors = formatValidationErrors(validateInvestigation.errors);
        continue;
      }

      const semanticIntegrityErrors = semanticIntegrityErrorsFor(preparedRequest, canonical);
      if (semanticIntegrityErrors.length > 0) {
        validationErrors = semanticIntegrityErrors;
        continue;
      }

      return { ok: true, investigation: canonical, rawResponses };
    }

    validationErrors = formatValidationErrors(validateInvestigation.errors);
  }

  return { ok: false, kind: "validation", validationErrors, rawResponses };
}
