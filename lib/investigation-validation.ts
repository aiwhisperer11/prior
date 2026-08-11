import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";

import investigationSchema from "@/lib/investigation.schema.json";
import type { SherlockInvestigation } from "@/types/sherlock";

export interface InvestigationValidationError {
  instancePath: string;
  message: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateInvestigation = ajv.compile(investigationSchema);

function isSherlockInvestigation(value: unknown): value is SherlockInvestigation {
  return validateInvestigation(value) as boolean;
}

/** Validates untrusted API and fixture data against the canonical schema. */
export function parseSherlockInvestigation(
  value: unknown,
): { ok: true; investigation: SherlockInvestigation } | { ok: false; errors: InvestigationValidationError[] } {
  if (isSherlockInvestigation(value)) {
    return { ok: true, investigation: value };
  }

  return {
    ok: false,
    errors: (validateInvestigation.errors ?? []).map((error: ErrorObject) => ({
      instancePath: error.instancePath || "/",
      message: error.message ?? error.keyword,
    })),
  };
}
