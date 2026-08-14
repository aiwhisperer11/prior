import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type OpenAI from "openai";

import { evaluateCaseGoogleSecOps } from "../lib/server/case-google-secops-assertions";
import { runSherlockInvestigation } from "../lib/server/sherlock-engine";
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

/**
 * Plumbing only — no real model call. Proves request-building and schema
 * validation, not that Sherlock reasons correctly on this case. That proof is
 * `npm run eval:case-google-secops` (scripts/eval-case-google-secops.ts),
 * which requires OPENAI_API_KEY and hits the real API. The expected fixture
 * here is a hand-vetted "known good" structure for testing the assertions
 * module itself, not a claim about model output.
 */
test("the shared server engine sends the canonical request for the Google SecOps case", async () => {
  const request = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  const calls: unknown[] = [];

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 },
    fakeClient([JSON.stringify(expected)], calls),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0] as { messages: Array<{ content: string }> };
  assert.match(call.messages[1].content, /CASE case-google-secops-2026/);
  assert.match(call.messages[1].content, /USER HYPOTHESES/);
});

test("the vetted Google SecOps expected snapshot passes its own assertions", () => {
  const request = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  const assertions = evaluateCaseGoogleSecOps(request, expected);

  assert.deepEqual(
    assertions.filter((assertion) => !assertion.passed),
    [],
    JSON.stringify(assertions, null, 2),
  );
});

test("an investigation that states a mechanism as confirmed fails the assertions", () => {
  const request = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  const investigation: SherlockInvestigation = {
    ...expected,
    hypotheses: expected.hypotheses.map((h) =>
      h.id === "H2" ? { ...h, statement: "A defective deploy definitively caused the freshness delays." } : h,
    ),
  };

  const assertions = evaluateCaseGoogleSecOps(request, investigation);
  const failed = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);

  assert.ok(failed.includes("No hypothesis is presented as a confirmed cause"));
});

/**
 * Regression test for a real false negative found live: the model wrote "A
 * shared regional data-availability dependency" for a genuine shared-
 * dependency hypothesis. The original pattern required "shared" to be
 * immediately adjacent to "dependency", which real descriptive phrasing
 * routinely breaks.
 */
test("mechanism pattern recognizes 'shared dependency' with intervening descriptive words", () => {
  const request = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  const investigation: SherlockInvestigation = {
    ...expected,
    hypotheses: expected.hypotheses.map((h) =>
      h.id === "H3" ? { ...h, statement: "A shared regional data-availability dependency serving Search, Stats Search, and Rule re-evaluation failed or was impaired." } : h,
    ),
  };

  const assertions = evaluateCaseGoogleSecOps(request, investigation);
  const mechanismCheck = assertions.find((a) => a.name === "Proposes at least two plausible, distinct mechanism hypotheses");
  assert.ok(mechanismCheck?.passed, JSON.stringify(mechanismCheck));
});

test("an investigation that gives root_cause_status a prime_suspect anyway fails the assertions", () => {
  const request = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  const investigation: SherlockInvestigation = {
    ...expected,
    prime_suspect: { hypothesis_id: "H2", justification: "H2 is the strongest available account.", condemning_datum: "c", absolving_datum: "a" },
  };

  const assertions = evaluateCaseGoogleSecOps(request, investigation);
  const failed = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);

  assert.ok(failed.includes("root_cause_status is structurally undetermined (not modeled as a hypothesis)"));
});

test("an investigation that smuggles the undetermined conclusion into a hypothesis statement fails the assertions", () => {
  const request = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  const investigation: SherlockInvestigation = {
    ...expected,
    hypotheses: [
      ...expected.hypotheses,
      {
        id: "H5",
        statement: "The root cause is undetermined from available public evidence and no single mechanism can be confirmed from the public record.",
        origin: "sherlock",
        status: "active",
        confidence: 50,
        supported_by: [{ evidence_id: "E2", reason: "r" }],
        contradicted_by: [],
        expected_but_absent_ids: [],
        would_be_refuted_by: "A postmortem.",
        killed_by: null,
        resurrection_condition: null,
      },
    ],
  };

  const assertions = evaluateCaseGoogleSecOps(request, investigation);
  const failed = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);

  assert.ok(failed.includes("No hypothesis restates the undetermined conclusion as a mechanism"));
});

/**
 * Regression test for a real false negative found live: the model wrote
 * "E10 resolves the incident without stating one" (referring back to "the
 * cause" mentioned earlier via the pronoun "one"), which correctly separates
 * recovery from causal explanation but didn't match the original regex's
 * requirement that "does not/is not" be followed directly by a repeated
 * "cause" — natural phrasing often elides the repeated noun via "without" +
 * pronoun instead. See docs/evaluation.md.
 */
test("separates-recovery-from-cause tolerates 'without stating one' pronoun phrasing", () => {
  const request = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  const investigation: SherlockInvestigation = {
    ...expected,
    coherence: {
      ...expected.coherence,
      explanation: "E2 says the cause was under investigation and E10 resolves the incident without stating one, while the case provides no internal telemetry.",
    },
  };

  const assertions = evaluateCaseGoogleSecOps(request, investigation);
  const failed = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);

  assert.ok(!failed.includes("Separates operational recovery from causal explanation"), JSON.stringify(failed));
});
