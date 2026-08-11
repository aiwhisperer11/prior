import assert from "node:assert/strict";
import test from "node:test";

import investigationSchema from "../lib/investigation.schema.json";
import {
  OPENAI_INVESTIGATION_WIRE_SCHEMA,
  UNSUPPORTED_OPENAI_STRICT_SCHEMA_KEYWORDS,
  deriveOpenAIWireSchema,
} from "../lib/wire-schema";

function findKeyword(value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => findKeyword(entry, keyword));
  if (value === null || typeof value !== "object") return false;

  return Object.entries(value).some(
    ([key, entry]) => key === keyword || findKeyword(entry, keyword),
  );
}

function collectStrippedKeywordsInSchema(value: unknown): string[] {
  const strippedKeywordSet = new Set<string>(UNSUPPORTED_OPENAI_STRICT_SCHEMA_KEYWORDS);
  const encountered = new Set<string>();

  function visit(entry: unknown): void {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }

    if (entry === null || typeof entry !== "object") return;

    for (const [key, nestedValue] of Object.entries(entry)) {
      if (strippedKeywordSet.has(key)) encountered.add(key);
      visit(nestedValue);
    }
  }

  visit(value);
  return [...encountered].sort();
}

test("the authoritative schema uses only explicitly reviewed stripped keywords", () => {
  const encountered = collectStrippedKeywordsInSchema(investigationSchema);

  assert.deepEqual(
    encountered,
    ["maximum", "minItems", "minimum"],
    `A new strict-output keyword would be removed without review. Encountered: ${encountered.join(", ") || "none"}`,
  );
});

test("derives a deep-cloned wire schema without mutating the source", () => {
  const sourceSnapshot = structuredClone(investigationSchema);
  const wireSchema = deriveOpenAIWireSchema(investigationSchema);

  assert.notStrictEqual(wireSchema, investigationSchema);
  assert.deepEqual(investigationSchema, sourceSnapshot);
  assert.equal(wireSchema.additionalProperties, false);
  assert.deepEqual(wireSchema.required, investigationSchema.required);
  assert.ok("$defs" in wireSchema);
  assert.equal(
    (wireSchema.properties as Record<string, unknown>).expectation_matrix !== undefined,
    true,
  );

  for (const keyword of UNSUPPORTED_OPENAI_STRICT_SCHEMA_KEYWORDS) {
    assert.equal(findKeyword(wireSchema, keyword), false, `${keyword} should be removed`);
  }
});

test("removes the allowlist recursively while retaining supported schema keywords", () => {
  const source = {
    type: "object",
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100, enum: [0, 100] },
      labels: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1 } },
      nested: {
        type: "object",
        allOf: [{ type: "object" }],
        properties: { code: { type: "string", pattern: "^[A-Z]+$" } },
        required: ["code"],
        additionalProperties: false,
      },
      reference: { $ref: "#/$defs/reference" },
    },
    required: ["score", "labels", "nested", "reference"],
    additionalProperties: false,
    $defs: { reference: { type: "string", description: "Preserved definition" } },
  };

  const wireSchema = deriveOpenAIWireSchema(source);

  for (const keyword of UNSUPPORTED_OPENAI_STRICT_SCHEMA_KEYWORDS) {
    assert.equal(findKeyword(wireSchema, keyword), false, `${keyword} should be removed recursively`);
  }

  assert.deepEqual(wireSchema.required, source.required);
  assert.equal(wireSchema.additionalProperties, false);
  assert.deepEqual((wireSchema.properties as Record<string, unknown>).reference, source.properties.reference);
  assert.deepEqual(wireSchema.$defs, source.$defs);
  assert.equal(source.properties.score.minimum, 0);
  assert.equal(source.properties.nested.allOf !== undefined, true);
});

test("exports the full investigation schema in an OpenAI response-format wrapper", () => {
  assert.equal(OPENAI_INVESTIGATION_WIRE_SCHEMA.name, "sherlock_investigation");
  assert.equal(OPENAI_INVESTIGATION_WIRE_SCHEMA.strict, true);
  assert.equal(OPENAI_INVESTIGATION_WIRE_SCHEMA.schema.additionalProperties, false);
});
