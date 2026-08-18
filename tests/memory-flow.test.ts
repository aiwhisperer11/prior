import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Client } from "pg";

import { POST } from "../app/api/investigate/route";
import type { AuditArtifact, AuditStorage } from "../lib/server/audit-storage";
import { runInvestigationFlow } from "../lib/server/investigation-flow";
import { cockroachPoolOptions, CockroachDBMemoryStore, MemoryStoreUnavailableError, type InvestigationMemoryStore, type PrecedentLead, type StoredInvestigation } from "../lib/server/memory-store";
import type { InvestigationIterationRequest, SherlockInvestigation } from "../types/sherlock";

function fixture<T>(path: string): T { return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T; }

/** Deterministic in-memory fake — these tests are about CockroachDB SQL shape, not audit storage, so this never touches a real bucket or disk. */
class InMemoryAuditStorage implements AuditStorage {
  private readonly objects = new Map<string, string>();
  async putImmutable(key: string, content: string, contentType: string): Promise<AuditArtifact> {
    this.objects.set(key, content);
    return { key, sha256: createHash("sha256").update(content, "utf8").digest("hex"), sizeBytes: Buffer.byteLength(content, "utf8"), contentType, verified: true, versionId: null, verifiedAt: new Date().toISOString() };
  }
  async getImmutable(key: string): Promise<string | null> { return this.objects.get(key) ?? null; }
}

test("E2E flow retrieves a mock precedent as a lead, investigates, and persists the snapshot", async () => {
  const saved: StoredInvestigation[] = [];
  const store: InvestigationMemoryStore = {
    findPrecedents: async (): Promise<PrecedentLead[]> => [{ caseId: "prior-case", investigationId: "prior-investigation", snapshotId: "prior-snapshot", sourceId: "prior-source", caseTitle: "Prior incident", domain: "IT incident", summary: "A similar certificate symptom.", isMock: true }],
    save: async (record) => { saved.push(record); },
  };
  const request: InvestigationIterationRequest = { ...fixture<InvestigationIterationRequest>("../examples/case-b.json"), iteration: 1 };
  const response = fixture<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  let received: InvestigationIterationRequest | undefined;
  const result = await runInvestigationFlow(request, store, async (input) => {
    received = input as InvestigationIterationRequest;
    return { ok: true, investigation: response, rawResponses: [] };
  });
  assert.equal(result.ok, true);
  assert.equal(result.storage, "local-mock");
  assert.equal(result.precedents[0]?.isMock, true);
  assert.equal(received?.precedent_leads?.[0]?.caseTitle, "Prior incident");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.isMock, true);
});

test("full flow never returns the current case as an external precedent", async () => {
  const request: InvestigationIterationRequest = { ...fixture<InvestigationIterationRequest>("../examples/case-b.json"), iteration: 1 };
  const response = fixture<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const store = {
    findPrecedents: async (): Promise<PrecedentLead[]> => [],
    findSemanticPrecedents: async (): Promise<PrecedentLead[]> => [{ caseId: request.case_id, caseTitle: "stale self", domain: request.domain, summary: "serialized self", isMock: true }],
    findLatestForCase: async () => null,
    save: async (): Promise<void> => {},
  };
  let received: InvestigationIterationRequest | undefined;
  const result = await runInvestigationFlow(request, store, async (input) => {
    received = input as InvestigationIterationRequest;
    return { ok: true, investigation: response, rawResponses: [] };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.precedents, []);
  assert.deepEqual(received?.precedent_leads, []);
});

const fakeEmbedder = async (text: string) => ({ vector: Array.from({ length: 4 }, (_, i) => text.length + i), model: "fake-embedder" });

test("CockroachDBMemoryStore uses parameterized queries and persists the snapshot", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [] }; } };
  const store = new CockroachDBMemoryStore(pool as never, new InMemoryAuditStorage(), fakeEmbedder);
  const investigation = fixture<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  await store.findPrecedents("IT incident", "case-b-checkout");
  await store.save({ investigation, isMock: false });
  assert.match(calls[0]!.sql, /case_id <> \$2/);
  assert.deepEqual(calls[0]!.values, ["IT incident", "case-b-checkout"]);
  assert.match(calls[1]!.sql, /WHERE case_id = \$1/);
  assert.match(calls[2]!.sql, /INSERT INTO investigation_memory/);
  assert.match(calls[2]!.sql, /audit_artifact_key/);
  assert.match(calls[2]!.sql, /audit_artifact_sha256/);
  assert.equal(calls[2]!.values[4], false);
  assert.match(calls[2]!.values[14] as string, /^investigations\/case-b-checkout\//);
  assert.match(calls[2]!.values[15] as string, /^[0-9a-f]{64}$/);
});

test("Cockroach configuration requires verified TLS from DATABASE_URL", () => {
  const options = cockroachPoolOptions("postgresql://user:password@cluster.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full");
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.throws(() => cockroachPoolOptions("postgresql://localhost:26257/defaultdb"), MemoryStoreUnavailableError);
});

test("Cockroach connection preserves the intended host when credentials contain percent-encoded reserved characters", () => {
  const password = encodeURIComponent("synthetic@:/#?%password");
  const databaseUrl = `postgresql://synthetic-user:${password}@synthetic-host.invalid:26257/defaultdb?sslmode=verify-full`;
  const options = cockroachPoolOptions(databaseUrl);
  const client = new Client(options);
  const connection = (client as unknown as {
    connectionParameters: { host: string; port: number; database: string; ssl: object };
  }).connectionParameters;

  assert.equal(connection.host, "synthetic-host.invalid");
  assert.equal(connection.port, 26257);
  assert.equal(connection.database, "defaultdb");
  assert.deepEqual(connection.ssl, {});
});

test("a CockroachDB failure is surfaced and never falls back to local memory", async () => {
  const store = new CockroachDBMemoryStore({ query: async () => { throw new Error("connection refused"); } } as never, new InMemoryAuditStorage());
  await assert.rejects(store.findPrecedents("IT incident", "case-b-checkout"), MemoryStoreUnavailableError);
});

test("an invalid DATABASE_URL makes the API return 503 instead of using LocalMemoryStore", async () => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "not-a-database-url";
  try {
    const request = fixture("../examples/case-b.json");
    const response = await POST(new Request("http://localhost/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }) as never);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "CockroachDB memory store is unavailable" });
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});

test("the assembled API response body exposes only safe audit lineage: backend, artifact key, sha256, verification status -- no bucket, region, or credentials", async () => {
  // findLatestForCase runs twice against the same SQL text: once inside
  // save() (checking for a prior snapshot -- there is none, this is a fresh
  // case) and once after save() completes (the post-save lineage lookup
  // that becomes the API's "memory" field). A counter distinguishes them
  // since the query text itself is identical both times.
  let findLatestForCaseCalls = 0;
  const calls: Array<{ sql: string }> = [];
  const pool = {
    query: async (sql: string) => {
      calls.push({ sql });
      if (/INSERT INTO investigation_memory/.test(sql)) return { rows: [] };
      if (/WHERE case_id = \$1/.test(sql)) {
        findLatestForCaseCalls += 1;
        if (findLatestForCaseCalls === 1) return { rows: [] }; // the in-save() prior-snapshot check: no prior.
        return { rows: [{
          id: "row-1", investigation_id: "inv-1", parent_snapshot_id: null, source_id: "src-1",
          model_version: "gpt-5.6-terra", prompt_version: "3.2.0", embedding_model: "text-embedding-3-small",
          snapshot: fixture<SherlockInvestigation>("../examples/case-b.expected-investigation.json"),
          audit_artifact_key: "investigations/case-b-checkout/inv-1/row-1.json",
          audit_artifact_sha256: "c".repeat(64),
          audit_artifact_backend: "local",
          audit_artifact_version_id: null,
          audit_artifact_verified_at: "2026-08-14T18:00:00.000Z",
        }] };
      }
      return { rows: [] };
    },
  };
  const store = new CockroachDBMemoryStore(pool as never, new InMemoryAuditStorage(), fakeEmbedder);
  const request: InvestigationIterationRequest = { ...fixture<InvestigationIterationRequest>("../examples/case-b.json"), iteration: 1 };
  const response = fixture<SherlockInvestigation>("../examples/case-b.expected-investigation.json");

  const result = await runInvestigationFlow(request, store, async () => ({ ok: true, investigation: response, rawResponses: [] }));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // This mirrors exactly what app/api/investigate/route.ts assigns to the "memory" field of NextResponse.json(...).
  const apiMemoryField = result.memory;
  assert.ok(apiMemoryField);
  // auditVerificationStatus is not on LatestCaseSnapshot at all -- it is derived client-side by parseMemory() from key+hash presence, never duplicated or trusted from the wire.
  assert.equal(apiMemoryField.auditArtifactKey, "investigations/case-b-checkout/inv-1/row-1.json");
  assert.equal(apiMemoryField.auditArtifactSha256, "c".repeat(64));
  assert.equal(apiMemoryField.auditStorageBackend, "local");
  assert.equal(apiMemoryField.auditArtifactVersionId, null);
  assert.equal(apiMemoryField.auditArtifactVerifiedAt, "2026-08-14T18:00:00.000Z");

  const keys = Object.keys(apiMemoryField);
  for (const forbidden of ["bucket", "region", "prefix", "credential", "accessKey", "secret", "presigned", "connectionString", "databaseUrl"]) {
    assert.ok(!keys.some((key) => key.toLowerCase().includes(forbidden.toLowerCase())), `API-facing memory lineage must never expose a "${forbidden}"-shaped field`);
  }
});
