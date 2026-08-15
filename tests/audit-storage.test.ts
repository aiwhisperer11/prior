import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { AuditIntegrityError, AuditStorageUnavailableError, LocalAuditStorage, S3AuditStorage, getAuditStorage, type S3ClientLike } from "../lib/server/audit-storage";

function sha256Of(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface FakeVersion { body: string; contentType: string; metadata: Record<string, string>; sse: string | undefined }

/**
 * Deterministic in-memory fake of the S3 surface S3AuditStorage actually
 * calls (Put/Head/Get), so tests never touch a real bucket. Reproduces the
 * specific behaviors S3AuditStorage depends on: IfNoneMatch conditional
 * writes rejecting an existing key (PreconditionFailed), Head/Get raising
 * NotFound/NoSuchKey for a missing key, echoing back Metadata, ContentType,
 * ContentLength, and ServerSideEncryption the way real S3 does, and real
 * per-key version history (a VersionId param pins Head/Get to that exact
 * version; omitting it resolves to whatever is currently "latest").
 */
class FakeS3Client implements S3ClientLike {
  private readonly versions = new Map<string, Map<string, FakeVersion>>();
  private readonly latest = new Map<string, string>();
  public putCalls = 0;
  private nextVersionId = 1;

  seedExisting(bucket: string, key: string, body: string, contentType = "application/json", metadata: Record<string, string> = { sha256: sha256Of(body) }) {
    const id = `${bucket}/${key}`;
    const versionId = `seed-v${this.nextVersionId++}`;
    this.versions.set(id, new Map([[versionId, { body, contentType, metadata, sse: "AES256" }]]));
    this.latest.set(id, versionId);
  }

  /** Simulates a write racing this test — advances "latest" without touching the version any in-flight putImmutable() call already captured. */
  pushConcurrentVersion(bucket: string, key: string, body: string) {
    const id = `${bucket}/${key}`;
    const versionId = `concurrent-v${this.nextVersionId++}`;
    const byKey = this.versions.get(id) ?? new Map<string, FakeVersion>();
    byKey.set(versionId, { body, contentType: "application/json", metadata: { sha256: sha256Of(body) }, sse: "AES256" });
    this.versions.set(id, byKey);
    this.latest.set(id, versionId);
    return versionId;
  }

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      this.putCalls += 1;
      const id = `${command.input.Bucket}/${command.input.Key}`;
      if (command.input.IfNoneMatch === "*" && this.latest.has(id)) {
        const error = new Error("At least one of the pre-conditions you specified did not hold");
        (error as { name?: string }).name = "PreconditionFailed";
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata = { httpStatusCode: 412 };
        throw error;
      }
      const versionId = `v${this.nextVersionId++}`;
      const byKey = this.versions.get(id) ?? new Map<string, FakeVersion>();
      byKey.set(versionId, {
        body: String(command.input.Body),
        contentType: command.input.ContentType ?? "",
        metadata: command.input.Metadata ?? {},
        sse: "AES256",
      });
      this.versions.set(id, byKey);
      this.latest.set(id, versionId);
      return { ServerSideEncryption: "AES256", VersionId: versionId };
    }
    if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
      const id = `${command.input.Bucket}/${command.input.Key}`;
      const requestedVersionId = command.input.VersionId ?? this.latest.get(id);
      const object = requestedVersionId ? this.versions.get(id)?.get(requestedVersionId) : undefined;
      if (!object) {
        const error = new Error(command instanceof HeadObjectCommand ? "Not Found" : "The specified key does not exist.");
        (error as { name?: string }).name = command instanceof HeadObjectCommand ? "NotFound" : "NoSuchKey";
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata = { httpStatusCode: 404 };
        throw error;
      }
      if (command instanceof HeadObjectCommand) return { ContentLength: Buffer.byteLength(object.body, "utf8"), ContentType: object.contentType, Metadata: object.metadata, ServerSideEncryption: object.sse, VersionId: requestedVersionId };
      return { Body: { transformToString: async () => object.body }, VersionId: requestedVersionId };
    }
    throw new Error(`FakeS3Client: unexpected command ${command?.constructor?.name}`);
  }
}

test("LocalAuditStorage writes real content and computes a real sha256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sherlock-audit-"));
  try {
    const storage = new LocalAuditStorage(dir);
    const artifact = await storage.putImmutable("case-x/raw-response.json", '{"hello":"world"}', "application/json");

    assert.equal(artifact.key, "case-x/raw-response.json");
    assert.equal(artifact.sizeBytes, Buffer.byteLength('{"hello":"world"}', "utf8"));
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.equal(artifact.verified, true);

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

test("S3AuditStorage: absent key writes, then independently verifies via HeadObject + GetObject before returning", async () => {
  const client = new FakeS3Client();
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);
  const content = JSON.stringify({ case_id: "case-x", hello: "world" });

  const artifact = await storage.putImmutable("investigations/case-x/inv-1/snap-1.json", content, "application/json");

  assert.equal(artifact.key, "investigations/case-x/inv-1/snap-1.json");
  assert.equal(artifact.sha256, sha256Of(content));
  assert.equal(artifact.sizeBytes, Buffer.byteLength(content, "utf8"));
  assert.equal(artifact.verified, true);
  assert.equal(client.putCalls, 1);

  const readBack = await storage.getImmutable("investigations/case-x/inv-1/snap-1.json");
  assert.equal(readBack, content);
});

test("S3AuditStorage: putImmutable captures the VersionId S3 returns from PutObject, and a real verifiedAt timestamp", async () => {
  const client = new FakeS3Client();
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);
  const content = JSON.stringify({ hello: "versioned" });

  const before = new Date();
  const artifact = await storage.putImmutable("k.json", content, "application/json");
  const after = new Date();

  assert.match(artifact.versionId ?? "", /^v\d+$/);
  const verifiedAt = new Date(artifact.verifiedAt);
  assert.ok(verifiedAt >= before && verifiedAt <= after, "verifiedAt must be stamped during this call, not a fixed or invented value");
});

test("S3AuditStorage: internal Head/Get verification is pinned to the exact VersionId PutObject returned, not resolved as 'latest'", async () => {
  // A client where an unpinned (no VersionId) Head/Get would serve the WRONG
  // object -- simulating "latest" having already moved on, mid-call, to a
  // concurrent write. If putImmutable's internal verify() omitted the
  // VersionId it captured from PutObject, this would fail as an
  // AuditIntegrityError (wrong content/hash). It doesn't -- proving the
  // verification calls really are pinned to that exact version.
  const correctContent = JSON.stringify({ revision: "correct" });
  const wrongContent = JSON.stringify({ revision: "wrong-if-unpinned" });
  const client: S3ClientLike = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) return { ServerSideEncryption: "AES256", VersionId: "the-real-version" };
      if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
        const pinned = command.input.VersionId === "the-real-version";
        const body = pinned ? correctContent : wrongContent;
        if (command instanceof HeadObjectCommand) return { ContentLength: Buffer.byteLength(body, "utf8"), ContentType: "application/json", Metadata: { sha256: sha256Of(pinned ? correctContent : wrongContent) }, ServerSideEncryption: "AES256" };
        return { Body: { transformToString: async () => body } };
      }
      throw new Error("unexpected command");
    },
  };
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);

  const artifact = await storage.putImmutable("k.json", correctContent, "application/json");
  assert.equal(artifact.versionId, "the-real-version");
  assert.equal(artifact.sha256, sha256Of(correctContent));
});

test("S3AuditStorage: getImmutable recovers a specific historical version exactly, distinct from whatever is currently latest", async () => {
  const client = new FakeS3Client();
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);

  const v1 = await storage.putImmutable("k.json", JSON.stringify({ revision: 1 }), "application/json");
  const v2VersionId = client.pushConcurrentVersion("test-bucket", "k.json", JSON.stringify({ revision: 2 }));

  assert.equal(await storage.getImmutable("k.json", v1.versionId ?? undefined), JSON.stringify({ revision: 1 }));
  assert.equal(await storage.getImmutable("k.json", v2VersionId), JSON.stringify({ revision: 2 }));
  assert.equal(await storage.getImmutable("k.json"), JSON.stringify({ revision: 2 })); // unpinned -> latest
});

test("S3AuditStorage: PutObject uses a conditional write (IfNoneMatch: \"*\") and stores the sha256 as object metadata", async () => {
  let capturedIfNoneMatch: string | undefined;
  let capturedMetadata: Record<string, string> | undefined;
  const client: S3ClientLike = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        capturedIfNoneMatch = command.input.IfNoneMatch;
        capturedMetadata = command.input.Metadata;
        return { ServerSideEncryption: "AES256" };
      }
      if (command instanceof HeadObjectCommand) return { ContentLength: 2, ContentType: "application/json", Metadata: capturedMetadata, ServerSideEncryption: "AES256" };
      if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => "{}" } };
      throw new Error("unexpected command");
    },
  };
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);
  await storage.putImmutable("k.json", "{}", "application/json");

  assert.equal(capturedIfNoneMatch, "*");
  assert.equal(capturedMetadata?.sha256, sha256Of("{}"));
});

test("S3AuditStorage: an existing key with identical content is idempotent success, not an error", async () => {
  const client = new FakeS3Client();
  const content = JSON.stringify({ same: "content" });
  client.seedExisting("test-bucket", "k.json", content);
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);

  const artifact = await storage.putImmutable("k.json", content, "application/json");

  assert.equal(artifact.sha256, sha256Of(content));
  assert.equal(artifact.verified, true);
});

test("S3AuditStorage: an existing key with different content is an integrity error, never a silent overwrite", async () => {
  const client = new FakeS3Client();
  client.seedExisting("test-bucket", "k.json", JSON.stringify({ original: true }));
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);

  await assert.rejects(
    storage.putImmutable("k.json", JSON.stringify({ different: true }), "application/json"),
    AuditIntegrityError,
  );
});

test("S3AuditStorage: a downloaded-content mismatch during verification is an integrity error, not treated as a successful write", async () => {
  const client: S3ClientLike = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) return { ServerSideEncryption: "AES256" };
      if (command instanceof HeadObjectCommand) return { ContentLength: 2, ContentType: "application/json", Metadata: { sha256: sha256Of("{}") }, ServerSideEncryption: "AES256" };
      // GetObject returns something other than what was written -- simulates corruption in transit or at rest.
      if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => "{\"corrupted\":true}" } };
      throw new Error("unexpected command");
    },
  };
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);
  await assert.rejects(storage.putImmutable("k.json", "{}", "application/json"), AuditIntegrityError);
});

test("S3AuditStorage: a reported SSE algorithm other than AES256 is an integrity error", async () => {
  const client: S3ClientLike = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) return { ServerSideEncryption: "aws:kms" };
      if (command instanceof HeadObjectCommand) return { ContentLength: 2, ContentType: "application/json", Metadata: { sha256: sha256Of("{}") }, ServerSideEncryption: "aws:kms" };
      if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => "{}" } };
      throw new Error("unexpected command");
    },
  };
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);
  await assert.rejects(storage.putImmutable("k.json", "{}", "application/json"), AuditIntegrityError);
});

test("S3AuditStorage.getImmutable returns null for a missing key rather than throwing", async () => {
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, new FakeS3Client());
  assert.equal(await storage.getImmutable("never-written.json"), null);
});

test("S3AuditStorage: an unexpected S3 failure surfaces as AuditStorageUnavailableError, not a generic error", async () => {
  const client: S3ClientLike = { send: async () => { throw new Error("network timeout"); } };
  const storage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, client);
  await assert.rejects(storage.putImmutable("k.json", "{}", "application/json"), AuditStorageUnavailableError);
});

test("getAuditStorage: s3 backend selected without AWS_S3_AUDIT_BUCKET fails closed, no silent fallback to local", () => {
  const originalBackend = process.env.AUDIT_STORAGE_BACKEND;
  const originalBucket = process.env.AWS_S3_AUDIT_BUCKET;
  const originalRegion = process.env.AWS_REGION;
  process.env.AUDIT_STORAGE_BACKEND = "s3";
  delete process.env.AWS_S3_AUDIT_BUCKET;
  process.env.AWS_REGION = "eu-central-1";
  try {
    assert.throws(() => getAuditStorage(), /AWS_S3_AUDIT_BUCKET/);
  } finally {
    if (originalBackend === undefined) delete process.env.AUDIT_STORAGE_BACKEND; else process.env.AUDIT_STORAGE_BACKEND = originalBackend;
    if (originalBucket === undefined) delete process.env.AWS_S3_AUDIT_BUCKET; else process.env.AWS_S3_AUDIT_BUCKET = originalBucket;
    if (originalRegion === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = originalRegion;
  }
});

test("getAuditStorage: s3 backend selected without AWS_REGION fails closed", () => {
  const originalBackend = process.env.AUDIT_STORAGE_BACKEND;
  const originalBucket = process.env.AWS_S3_AUDIT_BUCKET;
  const originalRegion = process.env.AWS_REGION;
  process.env.AUDIT_STORAGE_BACKEND = "s3";
  process.env.AWS_S3_AUDIT_BUCKET = "placeholder-bucket-name";
  delete process.env.AWS_REGION;
  try {
    assert.throws(() => getAuditStorage(), /AWS_REGION/);
  } finally {
    if (originalBackend === undefined) delete process.env.AUDIT_STORAGE_BACKEND; else process.env.AUDIT_STORAGE_BACKEND = originalBackend;
    if (originalBucket === undefined) delete process.env.AWS_S3_AUDIT_BUCKET; else process.env.AWS_S3_AUDIT_BUCKET = originalBucket;
    if (originalRegion === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = originalRegion;
  }
});

test("getAuditStorage: an invalid backend value fails closed rather than guessing", () => {
  const original = process.env.AUDIT_STORAGE_BACKEND;
  process.env.AUDIT_STORAGE_BACKEND = "s4-typo";
  try {
    assert.throws(() => getAuditStorage(), /AUDIT_STORAGE_BACKEND must be "local" or "s3"/);
  } finally {
    if (original === undefined) delete process.env.AUDIT_STORAGE_BACKEND; else process.env.AUDIT_STORAGE_BACKEND = original;
  }
});

test("getAuditStorage: unset AUDIT_STORAGE_BACKEND defaults to the real local adapter", () => {
  const original = process.env.AUDIT_STORAGE_BACKEND;
  delete process.env.AUDIT_STORAGE_BACKEND;
  try {
    assert.ok(getAuditStorage() instanceof LocalAuditStorage);
  } finally {
    if (original !== undefined) process.env.AUDIT_STORAGE_BACKEND = original;
  }
});
