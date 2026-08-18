import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceScoutLambdaHandler, type EvidenceScoutRecordFailureLog } from "../lib/server/evidence-scout-lambda-handler";

test("Lambda handler reports batchItemFailures by messageId for retryable failures while allowing success, terminal completion, and duplicate-delivery no-ops", async () => {
  const seen: string[] = [];
  const logs: unknown[] = [];
  const handler = createEvidenceScoutLambdaHandler({
    storeFactory: () => ({}) as never,
    logError: (entry) => logs.push(entry),
    performSearch: async (actionId) => {
      seen.push(actionId);
      if (actionId === "retryable") throw new Error("synthetic retryable failure");
    },
  });

  const response = await handler({
    Records: [
      { messageId: "m-success", body: JSON.stringify({ actionId: "success" }) },
      { messageId: "m-retry", body: JSON.stringify({ actionId: "retryable" }) },
      { messageId: "m-terminal", body: JSON.stringify({ actionId: "terminal" }) },
      { messageId: "m-duplicate", body: JSON.stringify({ actionId: "duplicate" }) },
    ],
  });

  assert.deepEqual(seen, ["success", "retryable", "terminal", "duplicate"]);
  assert.deepEqual(response, { batchItemFailures: [{ itemIdentifier: "m-retry" }] });
  assert.deepEqual(logs, [{
    event: "evidence_scout_record_failed",
    messageId: "m-retry",
    actionId: "retryable",
    errorName: "Error",
    errorMessage: "synthetic retryable failure",
  }]);
});

test("Lambda handler uses record.messageId, never actionId, in batchItemFailures", async () => {
  const handler = createEvidenceScoutLambdaHandler({
    storeFactory: () => ({}) as never,
    logError: () => {},
    performSearch: async () => {
      throw new Error("synthetic failure");
    },
  });

  const response = await handler({
    Records: [{ messageId: "aws-message-id-1", body: JSON.stringify({ actionId: "action-1" }) }],
  });

  assert.deepEqual(response, { batchItemFailures: [{ itemIdentifier: "aws-message-id-1" }] });
});

test("Lambda handler logs malformed records without their payload and sanitizes URLs and credentials", async () => {
  const logs: EvidenceScoutRecordFailureLog[] = [];
  const secret = "sk-test-secret-value";
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;

  try {
    const handler = createEvidenceScoutLambdaHandler({
      storeFactory: () => ({}) as never,
      logError: (entry) => logs.push(entry),
      performSearch: async () => {
        throw new TypeError(`request to https://private.example/path failed token=visible ${secret}`);
      },
    });

    const response = await handler({ Records: [
      { messageId: "m-error", body: JSON.stringify({ actionId: "action-1", payload: "must-not-be-logged" }) },
      { messageId: "m-malformed", body: "not-json-with-private-content" },
    ] });

    assert.deepEqual(response, { batchItemFailures: [
      { itemIdentifier: "m-error" },
      { itemIdentifier: "m-malformed" },
    ] });
    assert.deepEqual(logs[0], {
      event: "evidence_scout_record_failed",
      messageId: "m-error",
      actionId: "action-1",
      errorName: "TypeError",
      errorMessage: "request to [REDACTED_URL] failed token=[REDACTED] [REDACTED]",
    });
    assert.equal(logs[1]?.actionId, null);
    const serializedLogs = JSON.stringify(logs);
    assert.doesNotMatch(serializedLogs, /private\.example|must-not-be-logged|not-json-with-private-content|sk-test-secret-value|token=visible/);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("Lambda handler reports and logs store initialization failures per record", async () => {
  const logs: EvidenceScoutRecordFailureLog[] = [];
  const handler = createEvidenceScoutLambdaHandler({
    storeFactory: () => { throw new Error("DATABASE_URL is required"); },
    logError: (entry) => logs.push(entry),
  });

  const response = await handler({
    Records: [{ messageId: "m-store", body: JSON.stringify({ actionId: "action-store" }) }],
  });

  assert.deepEqual(response, { batchItemFailures: [{ itemIdentifier: "m-store" }] });
  assert.deepEqual(logs, [{
    event: "evidence_scout_record_failed",
    messageId: "m-store",
    actionId: "action-store",
    errorName: "Error",
    errorMessage: "DATABASE_URL is required",
  }]);
});
