import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import investigationSchema from "../lib/investigation.schema.json";

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

test("the Case B expected investigation conforms to the authoritative draft 2020-12 schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(investigationSchema);
  const expectedInvestigation = readJson("../examples/case-b.expected-investigation.json");

  assert.equal(validate(expectedInvestigation), true, JSON.stringify(validate.errors, null, 2));
});

test("the versioned Case B iteration-2 snapshot conforms to the authoritative schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(investigationSchema);
  const iterationTwo = readJson("../examples/case-b-iteration2-snapshot.json");

  assert.equal(validate(iterationTwo), true, JSON.stringify(validate.errors, null, 2));
});
