import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { CockroachDBEvidenceScoutCandidateStore } from "../lib/server/evidence-scout-store";
import { cockroachPoolOptions } from "../lib/server/cockroach-pool";

/**
 * The single genuinely live, cross-service smoke test for Governed Evidence
 * Scout: a real message on a real SQS queue, consumed by a real deployed
 * Lambda (infra/evidence-scout-lambda/), which makes a real OpenAI
 * `web_search` call and writes to a real CockroachDB cluster.
 *
 * Never run by `npm test` or any CI step in this repository -- run manually,
 * exactly like scripts/eval-case-b.ts and its siblings. Requires:
 *   - OPENAI_API_KEY (used only by the deployed Lambda, via its own Secrets
 *     Manager reference -- this script never sends the key anywhere itself)
 *   - DATABASE_URL pointed at a real CockroachDB cluster (sslmode=verify-full)
 *   - EVIDENCE_SCOUT_QUEUE_URL, the QueueUrl output of
 *     infra/evidence-scout-lambda/template.yaml after `sam deploy`
 *
 * This script deliberately does NOT go through the Next.js API route (no
 * server needs to be running) -- it exercises the queue and the database
 * directly, which is the actual cross-service boundary being verified.
 */

function loadEnvLocal(): void {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!process.env.OPENAI_API_KEY && existsSync(envPath)) process.loadEnvFile(envPath);
}

async function main(): Promise<void> {
  loadEnvLocal();

  const missing = ["DATABASE_URL", "EVIDENCE_SCOUT_QUEUE_URL"].filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing required environment variable(s): ${missing.join(", ")}. This script requires real, deployed infrastructure -- see infra/evidence-scout-lambda/README.md.`);
    process.exitCode = 1;
    return;
  }

  const pool = new (await import("pg")).Pool(cockroachPoolOptions(process.env.DATABASE_URL!));
  const store = new CockroachDBEvidenceScoutCandidateStore(pool);
  const sqs = new SQSClient({});

  const created = await store.createAction({
    caseId: "case-cloudflare-waf-2019",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the official Cloudflare postmortem for the 2019-07-02 outage.",
    queries: ["Cloudflare July 2 2019 outage postmortem CPU exhaustion"],
    maxCandidates: 5,
    allowedDomains: ["blog.cloudflare.com"],
    idempotencyKey: `live-smoke-${Date.now()}`,
  });
  if (!created.ok) {
    console.error(`createAction failed: ${created.code} -- ${created.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Action ${created.action.action_id} authorized. Sending to SQS...`);

  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.EVIDENCE_SCOUT_QUEUE_URL, MessageBody: JSON.stringify({ actionId: created.action.action_id }) }));
  console.log("Message sent. Polling for the Lambda-driven result (up to 60s)...");

  const deadline = Date.now() + 60_000;
  let finalState = "authorized";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const action = await store.getAction(created.action.action_id);
    if (!action) throw new Error("action disappeared mid-poll");
    finalState = action.state;
    if (action.state === "completed" || action.state === "failed") {
      console.log(`Final state: ${action.state}`);
      if (action.state === "failed") {
        console.error(`failure_code: ${action.failure_code}`);
        process.exitCode = 1;
        return;
      }
      console.log(`search_call_count: ${action.search_call_count} (must be <= 2)`);
      console.log(`candidates: ${action.candidates.length} (must be <= 5)`);
      const officialPrimary = action.candidates.find((c) => c.source_url.includes("blog.cloudflare.com"));
      if (!officialPrimary) {
        console.error("Expected at least one candidate hosted on blog.cloudflare.com; none found.");
        process.exitCode = 1;
        return;
      }
      for (const candidate of action.candidates) {
        if (!candidate.document_title && !candidate.publisher) {
          console.error(`Candidate ${candidate.candidate_id} has neither a title nor a publisher -- citation annotations may not be structurally well-formed as assumed.`);
          process.exitCode = 1;
          return;
        }
      }
      console.log("OK: Lambda -> OpenAI web_search -> CockroachDB round trip verified.");
      return;
    }
  }
  console.error(`Timed out after 60s; action never left state "${finalState}". Check the Lambda's CloudWatch logs and the DLQ.`);
  process.exitCode = 1;
}

main().catch((error) => {
  // Deliberately does not print `error` directly -- see the "never print
  // OPENAI_API_KEY / raw errors" constraint. Only the message, which in
  // Node's own Error objects never embeds environment variables unless a
  // caller explicitly interpolated one (this script never does).
  console.error(`Live evidence-scout SQS smoke test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
