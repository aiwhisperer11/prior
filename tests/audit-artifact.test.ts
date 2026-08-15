import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAuditArtifactEnvelope, buildAuditArtifactKey, computeArtifactSha256, sanitizeArtifactKeySegment, serializeAuditArtifact } from "../lib/server/audit-artifact";
import type { SherlockInvestigation } from "../types/sherlock";

const investigation = JSON.parse(readFileSync(new URL("../examples/case-b.expected-investigation.json", import.meta.url), "utf8")) as SherlockInvestigation;

const emptyRetrievedMemory = { related: [], longitudinal: [], suspectedDuplicates: [], unclassified: [] };

const fixedNow = () => new Date("2026-08-14T12:00:00.000Z");

function buildEnvelope() {
  return buildAuditArtifactEnvelope({
    investigation,
    investigationId: "inv-1",
    snapshotId: "snap-1",
    parentSnapshotId: null,
    modelVersion: "gpt-5.6-terra",
    promptVersion: "3.2.0",
    retrievedMemory: emptyRetrievedMemory,
    now: fixedNow,
  });
}

test("serialization is deterministic: the same envelope serializes identically on every call", () => {
  const a = serializeAuditArtifact(buildEnvelope());
  const b = serializeAuditArtifact(buildEnvelope());
  assert.equal(a, b);
});

test("serialization is stable under object key insertion order (JSON.stringify alone is not)", () => {
  const envelope = buildEnvelope();
  const reordered = JSON.parse(JSON.stringify(envelope));
  const shuffled = { created_at: reordered.created_at, ...reordered };
  assert.equal(serializeAuditArtifact(envelope), serializeAuditArtifact(shuffled));
});

test("the same content produces the same sha256, and different content produces a different one", () => {
  const serialized = serializeAuditArtifact(buildEnvelope());
  const a = computeArtifactSha256(serialized);
  const b = computeArtifactSha256(serialized);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);

  const different = serializeAuditArtifact(buildAuditArtifactEnvelope({
    investigation, investigationId: "inv-1", snapshotId: "snap-1", parentSnapshotId: null,
    modelVersion: "gpt-5.6-terra", promptVersion: "3.2.0", retrievedMemory: emptyRetrievedMemory,
    now: () => new Date("2026-08-14T12:00:01.000Z"), // one second later -> different created_at -> different content
  }));
  assert.notEqual(a, computeArtifactSha256(different));
});

test("the envelope carries no environment, credential, or connection-string fields", () => {
  const serialized = serializeAuditArtifact(buildEnvelope());
  for (const forbidden of ["DATABASE_URL", "AWS_ACCESS_KEY", "AWS_SECRET", "postgresql://", "AWS_PROFILE", "bucket_policy", "accountId"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"), `artifact must never contain ${forbidden}`);
  }
});

test("buildAuditArtifactKey produces the documented shape for ordinary identifiers", () => {
  assert.equal(buildAuditArtifactKey("case-google-secops-2026", "inv-1", "snap-1"), "investigations/case-google-secops-2026/inv-1/snap-1.json");
});

test("key segments are sanitized against path traversal and unexpected characters", () => {
  assert.equal(sanitizeArtifactKeySegment("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeArtifactKeySegment("case/with/slashes"), "case-with-slashes");
  assert.equal(sanitizeArtifactKeySegment("case with spaces"), "case-with-spaces");
  assert.equal(sanitizeArtifactKeySegment("..hidden"), "hidden");
  assert.doesNotMatch(buildAuditArtifactKey("../../etc/passwd", "inv/../1", "snap 1"), /\.\./);
  assert.doesNotMatch(buildAuditArtifactKey("a", "b", "c/../../d"), /\.\./);
});

test("a key segment that sanitizes to nothing is rejected rather than silently producing a malformed key", () => {
  assert.throws(() => sanitizeArtifactKeySegment("..."), /sanitized to empty/);
  assert.throws(() => sanitizeArtifactKeySegment("///"), /sanitized to empty/);
});

test("the audit artifact key uses the real case_id, investigation_id, and snapshot_id, not arbitrary values", () => {
  const key = buildAuditArtifactKey(investigation.meta.case_id, "real-investigation-id", "real-snapshot-id");
  assert.equal(key, `investigations/${investigation.meta.case_id}/real-investigation-id/real-snapshot-id.json`);
});
