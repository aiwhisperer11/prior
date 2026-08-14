import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type OpenAI from "openai";

import { evaluateCaseCloudflareWaf } from "../lib/server/case-cloudflare-waf-assertions";
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
 * This suite exercises only the plumbing (request building, schema
 * validation, assertions module) with a fake OpenAI client — it does not
 * call the real model, so it proves nothing about whether Sherlock actually
 * reasons correctly on this case. That proof is `npm run eval:case-cloudflare`
 * (scripts/eval-case-cloudflare.ts), which requires OPENAI_API_KEY and hits
 * the real API. The expected-investigation fixture used here is a hand-vetted
 * "known good" structure for testing the assertions module itself, not a
 * claim about model output.
 */
test("the shared server engine sends the canonical request for the Cloudflare WAF case", async () => {
  const request = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");
  const calls: unknown[] = [];

  const result = await runSherlockInvestigation(
    { ...request, iteration: 1 },
    fakeClient([JSON.stringify(expected)], calls),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0] as { messages: Array<{ content: string }> };
  assert.match(call.messages[1].content, /CASE case-cloudflare-waf-2019/);
  assert.match(call.messages[1].content, /USER HYPOTHESES/);
});

test("the vetted Cloudflare WAF expected snapshot passes its own assertions", () => {
  const request = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");
  const assertions = evaluateCaseCloudflareWaf(request, expected);

  assert.deepEqual(
    assertions.filter((assertion) => !assertion.passed),
    [],
    JSON.stringify(assertions, null, 2),
  );
});

test("an investigation that treats the attack theory as prime suspect fails the assertions", () => {
  const request = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");
  const investigation: SherlockInvestigation = {
    ...expected,
    prime_suspect: { ...expected.prime_suspect!, hypothesis_id: "H1" },
    hypotheses: expected.hypotheses.map((hypothesis) =>
      hypothesis.id === "H1" ? { ...hypothesis, status: "active", killed_by: null, resurrection_condition: null } : hypothesis,
    ),
  };

  const assertions = evaluateCaseCloudflareWaf(request, investigation);
  const failed = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);

  assert.ok(failed.includes("Attack hypothesis is not selected on early speculation alone"));
});
