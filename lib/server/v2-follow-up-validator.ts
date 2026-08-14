import Ajv2020 from "ajv/dist/2020.js";
import schema from "@/lib/v2-follow-up-request.schema.json";
import type { SourceEvidence } from "@/lib/server/case-file-compiler";
import { duplicateSourceIdIssues, mapAjvErrors } from "@/lib/server/v2-request-validation";

export interface V2FollowUpRequest {
  parent_snapshot_id: string;
  new_evidence: SourceEvidence[];
}

export type V2FollowUpValidationResult = { ok: true; request: V2FollowUpRequest } | { ok: false; errors: string[] };

const validateStructure = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

/**
 * Structural validation only (JSON Schema oneOf-style shape). Referential integrity
 * within the payload (duplicate source_id) is checked separately, the same way
 * parseV2CreateRequest does for the initial-creation endpoint.
 */
export function parseV2FollowUpRequest(value: unknown): V2FollowUpValidationResult {
  if (!validateStructure(value)) {
    return { ok: false, errors: mapAjvErrors(validateStructure.errors) };
  }
  const request = value as unknown as V2FollowUpRequest;
  const issues = duplicateSourceIdIssues(request.new_evidence, "new_evidence");
  if (issues.length) return { ok: false, errors: issues };
  return { ok: true, request };
}
