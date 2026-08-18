import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AuditStorageUnavailableError, S3AuditStorage, type AuditArtifact, type AuditStorage } from "../lib/server/audit-storage";
import { CockroachDBMemoryStore, LocalMemoryStore, MemoryLineageInvariantError, OrphanedAuditArtifactError, computeSourceId } from "../lib/server/memory-store";
import type { SherlockInvestigation } from "../types/sherlock";

/** Deterministic in-memory fake — these tests are about CockroachDB SQL shape, not audit storage, so this never touches a real bucket or disk. */
class InMemoryAuditStorage implements AuditStorage {
  readonly objects = new Map<string, string>();
  async putImmutable(key: string, content: string, contentType: string): Promise<AuditArtifact> {
    this.objects.set(key, content);
    return { key, sha256: createHash("sha256").update(content, "utf8").digest("hex"), sizeBytes: Buffer.byteLength(content, "utf8"), contentType, verified: true, versionId: null, verifiedAt: new Date().toISOString() };
  }
  async getImmutable(key: string): Promise<string | null> { return this.objects.get(key) ?? null; }
}

function investigation(overrides: Partial<{ caseId: string; iteration: number; summary: string; caseTitle: string; domain: string }> = {}): SherlockInvestigation {
  const { caseId = "case-x", iteration = 1, summary = "s", caseTitle = "Case X", domain = "test" } = overrides;
  return {
    schema_version: "1.0.0",
    meta: { case_id: caseId, case_title: caseTitle, iteration, domain },
    case: { observed_outcome: "Observed", expected_behavior: "Expected", evidence: [{ id: "E1", label: "L", content: "C", provided_in_iteration: 1, provenance: null }] },
    expectation_matrix: { expected_present: [], unexpected_present: [], expected_absent: [], unexpected_absent: [] },
    anomalies: [],
    hypotheses: [],
    missing_evidence: [],
    root_cause_status: "determined",
    undetermined_explanation: null,
    prime_suspect: { hypothesis_id: "H1", justification: "j", condemning_datum: "c", absolving_datum: "a" },
    coherence: { score: 50, explanation: "e" },
    open_case_index: { score: 50, explanation: "e" },
    next_test: { description: "d", discriminates_between: ["H1", "H2"], outcome_map: [], does_not_discriminate_from: [] },
    mirror_question: "q",
    learning: { is_baseline: true, summary, updates: [] },
  };
}

test("computeSourceId is deterministic for identical input and differs for different iterations", () => {
  const inv = investigation();
  const a = computeSourceId("case-x", 1, inv);
  const b = computeSourceId("case-x", 1, inv);
  const c = computeSourceId("case-x", 2, inv);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("LocalMemoryStore.save is idempotent: saving the identical snapshot twice does not create a second record", async () => {
  const store = new LocalMemoryStore(async () => ({ vector: [1, 0], model: "fake" }));
  const inv = investigation({ caseId: "case-dup" });
  await store.save({ investigation: inv, isMock: true });
  await store.save({ investigation: inv, isMock: true });
  const latest = await store.findLatestForCase("case-dup");
  assert.ok(latest);
  const precedents = await store.findPrecedents("test", "someone-else");
  assert.equal(precedents.filter((p) => p.caseId === "case-dup").length, 1);
});

test("LocalMemoryStore.findLatestForCase returns null for a case with no history", async () => {
  const store = new LocalMemoryStore(async () => ({ vector: [1, 0], model: "fake" }));
  assert.equal(await store.findLatestForCase("never-saved"), null);
});

test("LocalMemoryStore links investigation_id across iterations of the same case and updates the pointer to latest", async () => {
  const store = new LocalMemoryStore(async () => ({ vector: [1, 0], model: "fake" }));
  const first = investigation({ caseId: "case-continue", iteration: 1, summary: "first pass" });
  const second = investigation({ caseId: "case-continue", iteration: 2, summary: "second pass" });
  await store.save({ investigation: first, isMock: true });
  const afterFirst = await store.findLatestForCase("case-continue");
  await store.save({ investigation: second, isMock: true });
  const afterSecond = await store.findLatestForCase("case-continue");

  assert.ok(afterFirst && afterSecond);
  assert.equal(afterSecond!.investigationId, afterFirst!.investigationId, "same lineage thread across iterations");
  assert.equal(afterSecond!.snapshot.learning.summary, "second pass");
  assert.notEqual(afterSecond!.snapshotId, afterFirst!.snapshotId);
});

test("new iteration snapshots require a parent while a new baseline has none", async () => {
  const store = new LocalMemoryStore(async () => ({ vector: [1], model: "fake" }));
  await store.save({ investigation: investigation({ caseId: "baseline", iteration: 1 }), isMock: true });
  assert.equal((await store.findLatestForCase("baseline"))?.parentSnapshotId, null);
  await assert.rejects(
    store.save({ investigation: investigation({ caseId: "orphan", iteration: 2 }), isMock: true }),
    MemoryLineageInvariantError,
  );
});

test("LocalMemoryStore.findSemanticPrecedents ranks by real L2 distance, nearest first, excluding the current case", async () => {
  const store = new LocalMemoryStore(async (text) => {
    if (text.includes("near case")) return { vector: [1, 0], model: "fake" };
    if (text.includes("far case")) return { vector: [10, 0], model: "fake" };
    return { vector: [0, 0], model: "fake" }; // the query embedding
  });
  await store.save({ investigation: investigation({ caseId: "near", summary: "near case" }), isMock: true });
  await store.save({ investigation: investigation({ caseId: "far", summary: "far case" }), isMock: true });

  const results = await store.findSemanticPrecedents(
    { case_id: "self", case_title: "query", domain: "test", observed_outcome: "o", expected_behavior: "e", evidence: [] },
    "self",
  );
  assert.equal(results[0]?.caseId, "near");
  assert.equal(results[1]?.caseId, "far");
  assert.ok(results[0]!.similarityScore! < results[1]!.similarityScore!);
  assert.match(results[0]!.whyRelevant!, /Semantically closest/);
});

test("LocalMemoryStore.findSemanticPrecedents collapses multiple snapshots of the same external case before applying the limit", async () => {
  const store = new LocalMemoryStore(async (text) => {
    if (text.includes("cloudflare old")) return { vector: [0.05, 0], model: "fake" };
    if (text.includes("cloudflare new")) return { vector: [0.04, 0], model: "fake" };
    if (text.includes("google debug")) return { vector: [0.03, 0], model: "fake" };
    if (text.includes("other case")) return { vector: [0.02, 0], model: "fake" };
    return { vector: [0, 0], model: "fake" };
  });
  await store.save({ investigation: investigation({ caseId: "case-cloudflare-waf-2019", summary: "cloudflare old" }), isMock: true });
  await store.save({ investigation: investigation({ caseId: "case-cloudflare-waf-2019", iteration: 2, summary: "cloudflare new" }), isMock: true });
  await store.save({ investigation: investigation({ caseId: "case-google-debug", summary: "google debug" }), isMock: true });
  await store.save({ investigation: investigation({ caseId: "case-other", summary: "other case" }), isMock: true });

  const results = await store.findSemanticPrecedents(
    { case_id: "self", case_title: "query", domain: "test", observed_outcome: "o", expected_behavior: "e", evidence: [] },
    "self",
    2,
  );

  assert.deepEqual(results.map((item) => item.caseId), ["case-other", "case-google-debug"]);
  assert.equal(results.filter((item) => item.caseId === "case-cloudflare-waf-2019").length, 0);
});

test("a previous iteration is longitudinal memory, never an external precedent for its own case", async () => {
  const store = new LocalMemoryStore(async (text) => ({ vector: [text.includes("external") ? 1 : 0, 0], model: "fake" }));
  const first = investigation({ caseId: "current-case", iteration: 1, summary: "current first" });
  const second = investigation({ caseId: "current-case", iteration: 2, summary: "current second" });
  await store.save({ investigation: first, isMock: true });
  await store.save({ investigation: second, isMock: true });
  await store.save({ investigation: investigation({ caseId: "external-case", summary: "external precedent" }), isMock: true });

  const previousIteration = await store.findLatestForCase("current-case");
  const precedents = await store.findSemanticPrecedents(
    { case_id: "current-case", case_title: "current", domain: "test", observed_outcome: "o", expected_behavior: "e", evidence: [] },
    "current-case",
  );

  assert.equal(previousIteration?.snapshot.learning.summary, "current second");
  assert.ok(previousIteration?.parentSnapshotId, "iteration 2 retains its longitudinal parent");
  assert.deepEqual(precedents.map((item) => item.caseId), ["external-case"]);
  assert.ok(!precedents.some((item) => item.caseId === "current-case"));
});

test("CockroachDBMemoryStore.findSemanticPrecedents issues the real vector-index query shape", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ case_id: "prior", case_title: "Prior", domain: "d", summary: "s", distance: 0.42 }] }; } };
  const store = new CockroachDBMemoryStore(pool as never, new InMemoryAuditStorage(), async () => ({ vector: [1, 2, 3], model: "fake" }));

  const results = await store.findSemanticPrecedents(
    { case_id: "current", case_title: "t", domain: "d", observed_outcome: "o", expected_behavior: "e", evidence: [] },
    "current",
  );

  assert.match(calls[0]!.sql, /ORDER BY embedding <-> \$1/);
  assert.match(calls[0]!.sql, /ROW_NUMBER\(\) OVER \(PARTITION BY case_id ORDER BY iteration DESC, created_at DESC, id DESC\) AS snapshot_rank/);
  assert.match(calls[0]!.sql, /WHERE snapshot_rank = 1/);
  assert.match(calls[0]!.sql, /embedding IS NOT NULL/);
  assert.match(calls[0]!.sql, /case_id <> \$2/);
  assert.equal(calls[0]!.values[1], "current");
  assert.equal(results[0]?.similarityScore, 0.42);
});

test("CockroachDBMemoryStore.findLatestForCase queries by exact case_id (no exclusion) ordered to latest", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ id: "row-1", investigation_id: "inv-1", snapshot: investigation() }] }; } };
  const store = new CockroachDBMemoryStore(pool as never, new InMemoryAuditStorage(), async () => ({ vector: [1], model: "fake" }));

  const result = await store.findLatestForCase("case-continue");

  assert.match(calls[0]!.sql, /WHERE case_id = \$1/);
  assert.doesNotMatch(calls[0]!.sql, /case_id <>/);
  assert.equal(calls[0]!.values[0], "case-continue");
  assert.equal(result?.investigationId, "inv-1");
});

test("CockroachDBMemoryStore.save sends lineage and embedding columns with an idempotent ON CONFLICT clause", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      if (/WHERE case_id = \$1/.test(sql)) return { rows: [] }; // no prior snapshot
      return { rows: [] };
    },
  };
  const auditStorage = new InMemoryAuditStorage();
  const store = new CockroachDBMemoryStore(pool as never, auditStorage, async () => ({ vector: [1, 2], model: "fake-embed-model" }));
  const inv = investigation({ caseId: "case-new" });

  await store.save({ investigation: inv, isMock: false });

  const insertCall = calls.find((c) => /INSERT INTO investigation_memory/.test(c.sql));
  assert.ok(insertCall);
  assert.match(insertCall!.sql, /ON CONFLICT \(source_id\) WHERE source_id != '' DO NOTHING/);
  assert.match(insertCall!.sql, /audit_artifact_key/);
  assert.match(insertCall!.sql, /audit_artifact_sha256/);
  assert.match(insertCall!.sql, /audit_artifact_backend/);
  assert.match(insertCall!.sql, /audit_artifact_version_id/);
  assert.match(insertCall!.sql, /audit_artifact_verified_at/);
  assert.equal(insertCall!.values.length, 19);
  assert.equal(insertCall!.values[9], "gpt-5.6-terra"); // model_version = OPENAI_MODEL
  assert.equal(insertCall!.values[12], "fake-embed-model"); // embedding_model
  assert.match(insertCall!.values[13] as string, /^[0-9a-f-]{36}$/); // id: an app-generated UUID, not a DB default
  assert.match(insertCall!.values[14] as string, /^investigations\/case-new\//); // audit_artifact_key
  assert.match(insertCall!.values[15] as string, /^[0-9a-f]{64}$/); // audit_artifact_sha256
  assert.equal(insertCall!.values[16], "local"); // audit_artifact_backend: InMemoryAuditStorage is not an S3AuditStorage instance
  assert.equal(insertCall!.values[17], null); // audit_artifact_version_id: InMemoryAuditStorage never produces one
  assert.match(insertCall!.values[18] as string, /^\d{4}-\d{2}-\d{2}T/); // audit_artifact_verified_at: a real ISO timestamp
});

test("audit storage failure blocks the CockroachDB write entirely: the snapshot INSERT is never issued", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [] }; } };
  const failingAuditStorage: AuditStorage = {
    putImmutable: async () => { throw new AuditStorageUnavailableError("S3 is unreachable"); },
    getImmutable: async () => null,
  };
  const store = new CockroachDBMemoryStore(pool as never, failingAuditStorage, async () => ({ vector: [1], model: "fake" }));

  await assert.rejects(
    store.save({ investigation: investigation({ caseId: "case-s3-down" }), isMock: false }),
    AuditStorageUnavailableError,
  );

  assert.ok(!calls.some((c) => /INSERT INTO investigation_memory/.test(c.sql)), "no CockroachDB row may be written when the audit artifact was never durably stored");
});

test("a CockroachDB failure after a successful S3 write is reported as an orphaned artifact, and the object is never deleted", async () => {
  const pool = {
    query: async (sql: string) => {
      if (/WHERE case_id = \$1/.test(sql)) return { rows: [] }; // no prior snapshot
      if (/INSERT INTO investigation_memory/.test(sql)) throw new Error("connection reset");
      return { rows: [] };
    },
  };
  const auditStorage = new InMemoryAuditStorage();
  const store = new CockroachDBMemoryStore(pool as never, auditStorage, async () => ({ vector: [1], model: "fake" }));

  let caught: OrphanedAuditArtifactError | undefined;
  try {
    await store.save({ investigation: investigation({ caseId: "case-orphan" }), isMock: false });
  } catch (error) {
    assert.ok(error instanceof OrphanedAuditArtifactError);
    caught = error;
  }
  assert.ok(caught, "save() must reject with OrphanedAuditArtifactError");
  assert.match(caught!.artifactKey, /^investigations\/case-orphan\//);
  assert.match(caught!.artifactSha256, /^[0-9a-f]{64}$/);

  // The artifact really was durably written (S3 succeeded before CockroachDB
  // failed) and AuditStorage exposes no delete capability at all -- there is
  // no code path in this store that could have removed it.
  assert.equal(auditStorage.objects.size, 1);
  assert.ok(auditStorage.objects.has(caught!.artifactKey));
  assert.equal(typeof (auditStorage as unknown as { deleteImmutable?: unknown }).deleteImmutable, "undefined");
});

test("findLatestForCase recovers the persisted audit artifact key, sha256, backend, version_id, and verified_at from the row itself", async () => {
  const pool = {
    query: async () => ({
      rows: [{
        id: "row-1", investigation_id: "inv-1", parent_snapshot_id: null, source_id: "src-1",
        model_version: "m", prompt_version: "p", embedding_model: "e", snapshot: investigation(),
        audit_artifact_key: "investigations/case-continue/inv-1/row-1.json",
        audit_artifact_sha256: "b".repeat(64),
        audit_artifact_backend: "s3",
        audit_artifact_version_id: "s3-version-123",
        audit_artifact_verified_at: "2026-08-14T12:00:00.000Z",
      }],
    }),
  };
  // The store instance here is configured with InMemoryAuditStorage (a
  // "local"-shaped fake), but the row itself was written by an "s3" backend
  // -- findLatestForCase must report what the row actually says, not what
  // this store instance happens to be configured with right now.
  const store = new CockroachDBMemoryStore(pool as never, new InMemoryAuditStorage(), async () => ({ vector: [1], model: "fake" }));

  const result = await store.findLatestForCase("case-continue");

  assert.equal(result?.auditArtifactKey, "investigations/case-continue/inv-1/row-1.json");
  assert.equal(result?.auditArtifactSha256, "b".repeat(64));
  assert.equal(result?.auditStorageBackend, "s3");
  assert.equal(result?.auditArtifactVersionId, "s3-version-123");
  assert.equal(result?.auditArtifactVerifiedAt, "2026-08-14T12:00:00.000Z");
});

test("findLatestForCase reports every audit field as null for a historical row that predates this feature", async () => {
  const pool = {
    query: async () => ({
      rows: [{
        id: "row-1", investigation_id: "inv-1", parent_snapshot_id: null, source_id: "src-1",
        model_version: "m", prompt_version: "p", embedding_model: "e", snapshot: investigation(),
        audit_artifact_key: null, audit_artifact_sha256: null, audit_artifact_backend: null,
        audit_artifact_version_id: null, audit_artifact_verified_at: null,
      }],
    }),
  };
  const store = new CockroachDBMemoryStore(pool as never, new InMemoryAuditStorage(), async () => ({ vector: [1], model: "fake" }));

  const result = await store.findLatestForCase("case-legacy");

  assert.equal(result?.auditArtifactKey, null);
  assert.equal(result?.auditArtifactSha256, null);
  assert.equal(result?.auditStorageBackend, null, "backend must not be reported for a row with no artifact");
  assert.equal(result?.auditArtifactVersionId, null);
  assert.equal(result?.auditArtifactVerifiedAt, null);
});

test("save() persists backend, version_id, and verified_at exactly as captured by a real S3AuditStorage.putImmutable", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };
  // A real S3AuditStorage (not a hand-rolled AuditStorage fake), so
  // "instanceof S3AuditStorage" genuinely holds and audit_artifact_backend
  // is really derived that way, not asserted independently of the code path.
  const objects = new Map<string, { body: string; metadata: Record<string, string> }>();
  const fakeClient = {
    send: async (command: { input: { Bucket: string; Key: string; Body?: string; ContentType?: string; Metadata?: Record<string, string> } } & Record<string, unknown>) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const id = `${command.input.Bucket}/${command.input.Key}`;
      if (name === "PutObjectCommand") {
        objects.set(id, { body: command.input.Body as string, metadata: command.input.Metadata ?? {} });
        return { ServerSideEncryption: "AES256", VersionId: "real-s3-version-id" };
      }
      const object = objects.get(id);
      if (!object) { const error = new Error("not found"); (error as { name?: string }).name = "NoSuchKey"; throw error; }
      if (name === "HeadObjectCommand") return { ContentLength: Buffer.byteLength(object.body, "utf8"), ContentType: "application/json", Metadata: object.metadata, ServerSideEncryption: "AES256" };
      if (name === "GetObjectCommand") return { Body: { transformToString: async () => object.body } };
      throw new Error(`unexpected command ${name}`);
    },
  };
  const auditStorage = new S3AuditStorage({ bucket: "test-bucket", region: "eu-central-1" }, fakeClient as never);
  const store = new CockroachDBMemoryStore(pool as never, auditStorage, async () => ({ vector: [1], model: "fake" }));

  const before = new Date();
  await store.save({ investigation: investigation({ caseId: "case-versioned" }), isMock: false });
  const after = new Date();

  const insertCall = calls.find((c) => /INSERT INTO investigation_memory/.test(c.sql));
  assert.ok(insertCall);
  assert.equal(insertCall!.values[16], "s3"); // audit_artifact_backend
  assert.equal(insertCall!.values[17], "real-s3-version-id"); // audit_artifact_version_id: exactly what S3 returned from PutObject
  const verifiedAt = new Date(insertCall!.values[18] as string);
  assert.ok(verifiedAt >= before && verifiedAt <= after, "audit_artifact_verified_at must be a real timestamp stamped during this save()");
});

test("round-trip: a value written by save() and read back by findLatestForCase is byte-identical, including a null version_id for the local backend", async () => {
  const rows: unknown[] = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      if (/INSERT INTO investigation_memory/.test(sql)) {
        rows.push({
          id: values[13], investigation_id: values[6], parent_snapshot_id: values[7], source_id: values[8],
          model_version: values[9], prompt_version: values[10], embedding_model: values[12], snapshot: JSON.parse(values[5] as string),
          audit_artifact_key: values[14], audit_artifact_sha256: values[15], audit_artifact_backend: values[16],
          audit_artifact_version_id: values[17], audit_artifact_verified_at: values[18],
        });
        return { rows: [] };
      }
      return { rows: rows.slice(-1) }; // findLatestForCase: most recent write
    },
  };
  const auditStorage = new InMemoryAuditStorage();
  const store = new CockroachDBMemoryStore(pool as never, auditStorage, async () => ({ vector: [1], model: "fake" }));
  const inv = investigation({ caseId: "case-roundtrip" });

  await store.save({ investigation: inv, isMock: false });
  const readBack = await store.findLatestForCase("case-roundtrip");

  assert.equal(readBack?.auditStorageBackend, "local");
  assert.equal(readBack?.auditArtifactVersionId, null, "InMemoryAuditStorage never produces a version_id, matching the real local backend");
  assert.match(readBack?.auditArtifactKey ?? "", /^investigations\/case-roundtrip\//);
  assert.match(readBack?.auditArtifactSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.ok(readBack?.auditArtifactVerifiedAt);

  // The artifact really is retrievable by its persisted key, and its content hashes to the persisted sha256.
  const stored = await auditStorage.getImmutable(readBack!.auditArtifactKey!);
  assert.ok(stored);
  assert.equal(createHash("sha256").update(stored, "utf8").digest("hex"), readBack!.auditArtifactSha256);
});

test("exact-version recovery: S3AuditStorage.getImmutable retrieves the pinned VersionId, not whatever is currently latest at that key", async () => {
  const bucket = "test-bucket";
  const key = "investigations/case-x/inv-1/snap-1.json";
  const versions = new Map<string, { body: string; contentType: string; metadata: Record<string, string>; sse: string }>([
    ["v1", { body: JSON.stringify({ revision: 1 }), contentType: "application/json", metadata: { sha256: createHash("sha256").update(JSON.stringify({ revision: 1 }), "utf8").digest("hex") }, sse: "AES256" }],
    ["v2", { body: JSON.stringify({ revision: 2 }), contentType: "application/json", metadata: { sha256: createHash("sha256").update(JSON.stringify({ revision: 2 }), "utf8").digest("hex") }, sse: "AES256" }],
  ]);
  const currentVersion = "v2"; // "latest" has moved on past v1 -- simulates another write racing this test
  const client = {
    send: async (command: { input: { VersionId?: string } } & Record<string, unknown>) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const requestedVersion = command.input.VersionId ?? currentVersion;
      const object = versions.get(requestedVersion);
      if (!object) { const error = new Error("not found"); (error as { name?: string }).name = "NoSuchKey"; throw error; }
      if (name === "GetObjectCommand") return { Body: { transformToString: async () => object.body }, VersionId: requestedVersion };
      if (name === "HeadObjectCommand") return { ContentLength: Buffer.byteLength(object.body, "utf8"), ContentType: object.contentType, Metadata: object.metadata, ServerSideEncryption: object.sse, VersionId: requestedVersion };
      throw new Error(`unexpected command ${name}`);
    },
  };
  const storage = new S3AuditStorage({ bucket, region: "eu-central-1" }, client as never);

  const pinnedToV1 = await storage.getImmutable(key, "v1");
  const pinnedToV2 = await storage.getImmutable(key, "v2");
  const unpinned = await storage.getImmutable(key); // falls back to "current"

  assert.equal(pinnedToV1, JSON.stringify({ revision: 1 }));
  assert.equal(pinnedToV2, JSON.stringify({ revision: 2 }));
  assert.equal(unpinned, JSON.stringify({ revision: 2 }));
  assert.notEqual(pinnedToV1, unpinned, "an exact version request must not silently resolve to whatever is currently latest");
});
