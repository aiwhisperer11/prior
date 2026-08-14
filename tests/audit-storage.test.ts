import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalAuditStorage, S3AuditStorage } from "../lib/server/audit-storage";

test("LocalAuditStorage writes real content and computes a real sha256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sherlock-audit-"));
  try {
    const storage = new LocalAuditStorage(dir);
    const artifact = await storage.putImmutable("case-x/raw-response.json", '{"hello":"world"}', "application/json");

    assert.equal(artifact.key, "case-x/raw-response.json");
    assert.equal(artifact.sizeBytes, Buffer.byteLength('{"hello":"world"}', "utf8"));
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);

    const readBack = await storage.getImmutable("case-x/raw-response.json");
    assert.equal(readBack, '{"hello":"world"}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LocalAuditStorage.getImmutable returns null for a missing key rather than throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sherlock-audit-"));
  try {
    const storage = new LocalAuditStorage(dir);
    assert.equal(await storage.getImmutable("never-written"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3AuditStorage fails loudly instead of pretending to upload", async () => {
  const storage = new S3AuditStorage();
  await assert.rejects(storage.putImmutable("k", "v", "text/plain"), /AWS credentials not configured/);
  await assert.rejects(storage.getImmutable("k"), /AWS credentials not configured/);
});
