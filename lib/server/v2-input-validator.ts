import Ajv2020 from "ajv/dist/2020.js";
import schema from "@/lib/v2-input.schema.json";
import type { V2Input } from "@/lib/server/v2-snapshot-store";
import { duplicateSourceIdIssues, mapAjvErrors } from "@/lib/server/v2-request-validation";

export type V2CreateRequest = V2Input & { parent_snapshot_id?: string | null };

export interface V2InputValidationSuccess {
  ok: true;
  input: V2Input;
  parentSnapshotId: string | null;
}

export interface V2InputValidationFailure {
  ok: false;
  errors: string[];
}

export type V2InputValidationResult = V2InputValidationSuccess | V2InputValidationFailure;

const validateStructure = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

/**
 * A discriminated union only constrains input_mode's literal value at compile time; it does
 * not check that the JSON actually sent to the route matches either branch's shape. These
 * checks catch things a JSON Schema oneOf cannot express: cross-item referential integrity
 * within a single payload (duplicate source_id, dangling prerequisite_step).
 */
function validateReferentialIntegrity(input: V2Input): string[] {
  const issues: string[] = [];
  if (input.input_mode === "source_evidence") {
    issues.push(...duplicateSourceIdIssues(input.evidence_package, "evidence_package"));
  } else {
    const stepIds = new Set(input.causal_chain.map((step) => step.step_id));
    const seen = new Set<string>();
    for (const step of input.causal_chain) {
      if (seen.has(step.step_id)) issues.push(`causal_chain: duplicate step_id "${step.step_id}" within a single payload`);
      seen.add(step.step_id);
      if (step.prerequisite_step !== null && !stepIds.has(step.prerequisite_step)) {
        issues.push(`causal_chain: step "${step.step_id}" references nonexistent prerequisite_step "${step.prerequisite_step}"`);
      }
    }
  }
  return issues;
}

export function parseV2CreateRequest(value: unknown): V2InputValidationResult {
  if (!validateStructure(value)) {
    return { ok: false, errors: mapAjvErrors(validateStructure.errors) };
  }
  const { parent_snapshot_id, ...input } = value as V2CreateRequest;
  const referentialIssues = validateReferentialIntegrity(input);
  if (referentialIssues.length) return { ok: false, errors: referentialIssues };
  return { ok: true, input, parentSnapshotId: parent_snapshot_id ?? null };
}
