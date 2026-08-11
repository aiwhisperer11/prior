import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import type OpenAI from "openai";

import investigationSchema from "@/lib/investigation.schema.json";
import { getOpenAIClient } from "@/lib/openai";
import { buildInvestigationUserMessage, SYSTEM_PROMPT } from "@/lib/sherlock-prompt";
import { OPENAI_INVESTIGATION_WIRE_SCHEMA } from "@/lib/wire-schema";
import type {
  InvestigationIterationRequest,
  InvestigationRequest,
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

  return { ok: true, request: { ...value, iteration: 1 } };
}

function parseModelResponse(content: string): unknown {
  return JSON.parse(content) as unknown;
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
  const preparedRequest: InvestigationIterationRequest = "iteration" in request
    ? request
    : { ...request, iteration: 1 };
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
      return { ok: true, investigation: candidate, rawResponses };
    }

    validationErrors = formatValidationErrors(validateInvestigation.errors);
  }

  return { ok: false, kind: "validation", validationErrors, rawResponses };
}
