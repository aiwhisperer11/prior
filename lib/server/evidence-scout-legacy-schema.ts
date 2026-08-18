import Ajv2020 from "ajv/dist/2020.js";

import investigationSchema from "@/lib/investigation.schema.json";
import type { SherlockInvestigation } from "@/types/sherlock";

/**
 * Point 12: two deliberately distinct AJV validators, never one reused for
 * both jobs.
 *
 * The authoritative schema (lib/investigation.schema.json, compiled as
 * `validateInvestigation` in sherlock-engine.ts) requires `provenance` on
 * every evidence item -- required + nullable, the same pattern as
 * prime_suspect/killed_by, matching what OpenAI's strict Structured Outputs
 * mode needs (every property listed in `required`; optionality is expressed
 * only via a nullable type, never via omission). That validator gates a
 * fresh model response and the final canonical investigation before ok:true
 * is ever returned.
 *
 * This module exists for exactly one different job: accepting an incoming
 * previous_snapshot on a follow-up request. A real investigation persisted
 * before the provenance field existed literally lacks the key on its
 * evidence items -- not `null`, absent -- and the strict validator would
 * reject it, making every investigation that predates this feature
 * permanently un-followupable. LEGACY_RELAXED_REQUIRED_EXCLUSIONS is the
 * only list to extend if a future field has the same problem; this module
 * is never used to accept a fresh model response, and never gates the
 * final ok:true return value in sherlock-engine.ts.
 */
const LEGACY_RELAXED_REQUIRED_EXCLUSIONS = ["provenance"];

function buildLegacyCompatibleSchema(): object {
  const cloned = JSON.parse(JSON.stringify(investigationSchema)) as {
    properties: { case: { properties: { evidence: { items: { required: string[] } } } } };
  };
  const evidenceItemSchema = cloned.properties.case.properties.evidence.items;
  evidenceItemSchema.required = evidenceItemSchema.required.filter((field) => !LEGACY_RELAXED_REQUIRED_EXCLUSIONS.includes(field));
  return cloned;
}

const legacyAjv = new Ajv2020({ allErrors: true, strict: true });
const validateLegacyCompatibleSnapshot = legacyAjv.compile(buildLegacyCompatibleSchema());

export function isLegacyCompatiblePreviousSnapshot(value: unknown): value is SherlockInvestigation {
  return validateLegacyCompatibleSnapshot(value) as boolean;
}
