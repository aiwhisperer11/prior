import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type OpenAI from "openai";

import { evaluateCaseB } from "../lib/server/case-b-assertions";
import {
  OPENAI_MODEL,
  prepareInvestigationRequest,
  runSherlockInvestigation,
} from "../lib/server/sherlock-engine";
import type { InvestigationRequest, SherlockInvestigation } from "../types/sherlock";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

function fakeClient(responses: string[], calls: unknown[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (request: unknown) => {
          calls.push(request);
          return { choices: [{ message: { content: responses.shift() ?? null } }] };
        },
      },
    },
  } as unknown as OpenAI;
}

test("the shared server engine sends the canonical request and validates Case B with AJV", async () => {
  const request = readJson<InvestigationRequest>("../examples/case-b.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const calls: unknown[] = [];

  const result = await runSherlockInvestigation(
    request,
    fakeClient([JSON.stringify(expected)], calls),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0] as { model: string; messages: Array<{ content: string }> };
  assert.equal(call.model, OPENAI_MODEL);
  assert.match(call.messages[0].content, /P1\. DATA KILLS NARRATIVE/);
  assert.match(call.messages[1].content, /CASE case-b-checkout/);
  assert.match(call.messages[1].content, /USER HYPOTHESES/);
});

test("the shared server engine retries one invalid schema response", async () => {
  const request = readJson<InvestigationRequest>("../examples/case-b.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const calls: unknown[] = [];

  const result = await runSherlockInvestigation(
    request,
    fakeClient(["{\"invalid\":true}", JSON.stringify(expected)], calls),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

test("an iteration retains prior evidence, assigns E5 server-side, and includes iteration context", async () => {
  const previousSnapshot = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const prepared = prepareInvestigationRequest({
    previous_snapshot: previousSnapshot,
    new_evidence: [{ label: "Certificate audit", content: "A new certificate observation." }],
  });

  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.request.iteration, 2);
  assert.equal(prepared.request.evidence.at(-1)?.id, "E5");
  assert.equal(prepared.request.new_evidence?.[0]?.provided_in_iteration, 2);

  const calls: unknown[] = [];
  await runSherlockInvestigation(prepared.request, fakeClient([JSON.stringify(expected)], calls));
  const call = calls[0] as { messages: Array<{ content: string }> };
  assert.match(call.messages[1].content, /Iteration: 2/);
  assert.match(call.messages[1].content, /PREVIOUS SNAPSHOT/);
  assert.match(call.messages[1].content, /\[E5\] Certificate audit/);
});

test("baseline requests without required case data or evidence are rejected", () => {
  const missingEvidence = prepareInvestigationRequest({
    case_id: "case-empty",
    case_title: "Empty",
    domain: "Test",
    observed_outcome: "Observed",
    expected_behavior: "Expected",
    evidence: [],
  });

  assert.equal(missingEvidence.ok, false);
  if (!missingEvidence.ok) assert.match(missingEvidence.message, /at least one evidence/i);
});

test("the Case B semantic assertions accept the vetted expected snapshot", () => {
  const request = readJson<InvestigationRequest>("../examples/case-b.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const assertions = evaluateCaseB(request, expected);

  assert.deepEqual(
    assertions.filter((assertion) => !assertion.passed),
    [],
    JSON.stringify(assertions, null, 2),
  );
});

function assertionNamed(
  request: InvestigationRequest,
  investigation: SherlockInvestigation,
  name: string,
) {
  const assertion = evaluateCaseB(request, investigation).find((entry) => entry.name === name);
  assert.ok(assertion, `Missing assertion: ${name}`);
  return assertion;
}

const nextTestAssertionName = "next_test structurally discriminates the prime suspect";

test("a structurally discriminating next test passes even when its prose is imperfect", () => {
  const request = readJson<InvestigationRequest>("../examples/case-b.json");
  const investigation = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  investigation.next_test.description = "Check it.";

  assert.equal(assertionNamed(request, investigation, nextTestAssertionName).passed, true);
});

test("a confirmatory next test without an outcome weakening the prime suspect fails", () => {
  const request = readJson<InvestigationRequest>("../examples/case-b.json");
  const investigation = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  investigation.next_test.outcome_map = investigation.next_test.outcome_map.map((outcome) => ({
    ...outcome,
    weakens_hypothesis_id: outcome.weakens_hypothesis_id === "H3" ? "H1" : outcome.weakens_hypothesis_id,
  }));

  assert.equal(assertionNamed(request, investigation, nextTestAssertionName).passed, false);
});

test("an outcome favoring a hypothesis outside discriminates_between fails", () => {
  const request = readJson<InvestigationRequest>("../examples/case-b.json");
  const investigation = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  investigation.next_test.outcome_map = investigation.next_test.outcome_map.map((outcome) =>
    outcome.weakens_hypothesis_id === "H3"
      ? { ...outcome, favors_hypothesis_id: "H2" }
      : outcome,
  );

  assert.equal(assertionNamed(request, investigation, nextTestAssertionName).passed, false);
});
