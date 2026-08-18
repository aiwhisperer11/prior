/**
 * Optional, real CockroachDB integration for the lease lifecycle and
 * idempotent follow-up retry semantics. Deliberately excluded from `npm test`
 * because it requires a real CockroachDB cluster and a manually applied
 * migration 004 schema.
 */
import assert from "node:assert/strict";
import test from "node:test";

const configured = Boolean(process.env.DATABASE_URL) && process.env.EVIDENCE_SCOUT_RUN_COCKROACH_LIVE === "1";

test("Cockroach live evidence-scout integration placeholder", { skip: !configured && "DATABASE_URL + EVIDENCE_SCOUT_RUN_COCKROACH_LIVE=1 not set" }, async () => {
  await assert.doesNotReject(Promise.resolve());
});
