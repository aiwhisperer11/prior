import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  appendInvestigationSnapshot,
  followUpFormReducer,
  initialFollowUpFormState,
} from "../lib/follow-up-form-state";
import type { SherlockInvestigation } from "../types/sherlock";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

test("a re-investigation immediately enters a pending state", () => {
  const pending = followUpFormReducer(initialFollowUpFormState, { type: "request-started" });

  assert.equal(pending.loading, true);
  assert.equal(pending.error, null);
});

test("a pending re-investigation ignores duplicate submissions", () => {
  const pending = followUpFormReducer(initialFollowUpFormState, { type: "request-started" });

  assert.strictEqual(followUpFormReducer(pending, { type: "request-started" }), pending);
});

test("a successful re-investigation appends the updated snapshot", () => {
  const baseline = readJson<SherlockInvestigation>("../examples/case-b-baseline-snapshot.json");
  const updated = readJson<SherlockInvestigation>("../examples/case-b-iteration2-snapshot.json");

  const snapshots = appendInvestigationSnapshot([baseline], updated);

  assert.equal(snapshots.length, 2);
  assert.strictEqual(snapshots.at(-1), updated);
  assert.equal(followUpFormReducer(initialFollowUpFormState, { type: "request-succeeded" }).loading, false);
});

test("a failed re-investigation retains entered evidence", () => {
  const withEvidence = followUpFormReducer(initialFollowUpFormState, {
    type: "example-loaded",
    evidence: [{ label: "Certificate audit", content: "The certificate was expired." }],
  });
  const failed = followUpFormReducer(
    followUpFormReducer(withEvidence, { type: "request-started" }),
    { type: "request-failed", error: "Error 502: OpenAI request failed" },
  );

  assert.deepEqual(failed.evidence, withEvidence.evidence);
  assert.equal(failed.loading, false);
  assert.equal(failed.error, "Error 502: OpenAI request failed");
});
