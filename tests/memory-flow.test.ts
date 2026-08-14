import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { POST } from "../app/api/investigate/route";
import { runInvestigationFlow } from "../lib/server/investigation-flow";
import { cockroachPoolOptions, CockroachDBMemoryStore, MemoryStoreUnavailableError, type InvestigationMemoryStore, type PrecedentLead, type StoredInvestigation } from "../lib/server/memory-store";
import type { InvestigationIterationRequest, SherlockInvestigation } from "../types/sherlock";

function fixture<T>(path: string): T { return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T; }

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
  const store = new CockroachDBMemoryStore(pool as never, fakeEmbedder);
  const investigation = fixture<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  await store.findPrecedents("IT incident", "case-b-checkout");
  await store.save({ investigation, isMock: false });
  assert.match(calls[0]!.sql, /case_id <> \$2/);
  assert.deepEqual(calls[0]!.values, ["IT incident", "case-b-checkout"]);
  assert.match(calls[1]!.sql, /WHERE case_id = \$1/);
  assert.match(calls[2]!.sql, /INSERT INTO investigation_memory/);
  assert.equal(calls[2]!.values[4], false);
});

test("Cockroach configuration requires verified TLS from DATABASE_URL", () => {
  const options = cockroachPoolOptions("postgresql://user:password@cluster.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full");
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.throws(() => cockroachPoolOptions("postgresql://localhost:26257/defaultdb"), MemoryStoreUnavailableError);
});

test("a CockroachDB failure is surfaced and never falls back to local memory", async () => {
  const store = new CockroachDBMemoryStore({ query: async () => { throw new Error("connection refused"); } } as never);
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
