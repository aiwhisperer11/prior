import investigationSchema from "./investigation.schema.json";

export type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema keywords that OpenAI documents as unsupported in its strict
 * Structured Outputs subset. Constraint keywords remain enforced by AJV
 * against the authoritative schema after a response is received.
 */
export const UNSUPPORTED_OPENAI_STRICT_SCHEMA_KEYWORDS = [
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "multipleOf",
  "patternProperties",
  "minItems",
  "maxItems",
] as const;

const unsupportedKeywordSet = new Set<string>(UNSUPPORTED_OPENAI_STRICT_SCHEMA_KEYWORDS);

/**
 * Returns a deep-cloned Structured Outputs schema without mutating the
 * authoritative investigation schema.
 */
export function deriveOpenAIWireSchema(schema: JsonSchema): JsonSchema {
  return transformSchemaValue(schema) as JsonSchema;
}

function transformSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(transformSchemaValue);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nestedValue]) =>
      unsupportedKeywordSet.has(key) ? [] : [[key, transformSchemaValue(nestedValue)]],
    ),
  );
}

/**
 * Contract used by the OpenAI Chat Completions investigation route.
 */
export const OPENAI_INVESTIGATION_WIRE_SCHEMA = {
  name: "sherlock_investigation",
  strict: true,
  schema: deriveOpenAIWireSchema(investigationSchema as JsonSchema),
} as const;
