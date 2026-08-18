import assert from "node:assert/strict";
import test from "node:test";

import { SendMessageCommand } from "@aws-sdk/client-sqs";

import { SqsEvidenceScoutExecutor } from "../lib/server/evidence-scout-executor";

test("SqsEvidenceScoutExecutor awaits SendMessage and sends the minimal payload", async () => {
  let sentCommand: SendMessageCommand | null = null;
  let settled = false;
  let resolveSend: (() => void) | undefined;
  let markSent: (() => void) | undefined;

  const sendGate = new Promise<void>((resolve) => { resolveSend = resolve; });
  const sent = new Promise<void>((resolve) => { markSent = resolve; });
  const client = {
    send: async (command: SendMessageCommand) => {
      sentCommand = command;
      markSent?.();
      await sendGate;
    },
  };

  const executor = new SqsEvidenceScoutExecutor(client as never, "https://sqs.example.com/queue");
  const invokePromise = executor.invoke("action-123").then(() => { settled = true; });

  await sent;
  assert.equal(settled, false);

  resolveSend?.();
  await invokePromise;

  assert.notEqual(sentCommand, null);
  const command = sentCommand as unknown as SendMessageCommand;
  assert.ok(command instanceof SendMessageCommand);
  assert.equal(command.input.QueueUrl, "https://sqs.example.com/queue");
  assert.deepEqual(JSON.parse(command.input.MessageBody ?? "{}"), { actionId: "action-123" });
});
