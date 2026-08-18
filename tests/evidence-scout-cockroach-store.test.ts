import assert from "node:assert/strict";
import test from "node:test";

import { CockroachDBEvidenceScoutCandidateStore } from "../lib/server/evidence-scout-store";

function actionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "action-1",
    case_id: "case-1",
    investigation_id: null,
    missing_evidence_id: null,
    query_intent: "Find source",
    queries: ["query"],
    max_candidates: 1,
    allowed_domains: null,
    state: "authorized",
    authorized_at: "2026-08-16T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failure_code: null,
    search_call_count: 0,
    attempt_count: 0,
    ...overrides,
  };
}

function candidateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "candidate-1",
    action_id: "action-1",
    case_id: "case-1",
    query: "query",
    publisher: "Publisher",
    document_title: "Document",
    source_url: "https://example.com/source",
    claim_summary: "summary",
    cited_text: null,
    fragment: null,
    tier: "official_primary",
    state: "pending",
    verification_status: "source_located",
    source_reliability: "unknown",
    retrieved_at: "2026-08-16T00:00:00.000Z",
    decided_at: null,
    evidence_id: null,
    snapshot_id: null,
    iteration: null,
    ...overrides,
  };
}

test("Cockroach evidence-scout SQL clears leased_by and leased_until on every searching -> terminal transition", async () => {
  const poolCalls: string[] = [];
  const clientCalls: string[] = [];
  const client = {
    query: async (sql: string) => {
      clientCalls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      return { rows: [{ id: "action-1" }], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    query: async (sql: string) => {
      poolCalls.push(sql);
      if (sql.includes("FROM evidence_scout_action WHERE id = $1")) return { rows: [actionRow()] };
      if (sql.includes("FROM evidence_scout_candidate")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
    connect: async () => client,
  };

  const store = new CockroachDBEvidenceScoutCandidateStore(pool as never);
  await store.getAction("action-1");
  await store.completeAction("action-1", "worker-1", [], 1);
  await store.failAction("action-1", "worker-1", "search_api_error");

  assert.ok(poolCalls.some((sql) => sql.includes("leased_by = NULL") && sql.includes("leased_until = NULL")), "lazy reap must clear both lease columns");
  assert.ok(clientCalls.some((sql) => sql.includes("SET state = 'completed'") && sql.includes("leased_by = NULL") && sql.includes("leased_until = NULL")), "completeAction must clear both lease columns");
  assert.ok(poolCalls.some((sql) => sql.includes("SET state = 'failed'") && sql.includes("leased_by = NULL") && sql.includes("leased_until = NULL")), "failAction must clear both lease columns");
});

test("Cockroach createAction revives dispatch_failed rows for same-key redispatch", async () => {
  const sqlCalls: string[] = [];
  const client = {
    query: async (sql: string) => {
      sqlCalls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM evidence_scout_action WHERE case_id = $1 AND idempotency_key = $2")) {
        return { rows: [actionRow({ state: "failed", failure_code: "dispatch_failed", completed_at: "2026-08-16T00:01:00.000Z" })] };
      }
      if (sql.includes("SET state = 'authorized', failure_code = NULL, completed_at = NULL")) {
        return { rows: [actionRow({ state: "authorized" })], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => client };

  const store = new CockroachDBEvidenceScoutCandidateStore(pool as never);
  const created = await store.createAction({
    caseId: "case-1",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find source",
    queries: ["query"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: "same-key",
  });

  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.action.state, "authorized");
  assert.equal(created.shouldDispatch, true);
  assert.ok(sqlCalls.some((sql) => sql.includes("SET state = 'authorized', failure_code = NULL, completed_at = NULL")));
});

test("Cockroach store rejects accepting source_located candidates before issuing the UPDATE", async () => {
  const sqlCalls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("FROM evidence_scout_candidate c JOIN evidence_scout_action a ON a.id = c.action_id")) {
        return { rows: [candidateRow()] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const store = new CockroachDBEvidenceScoutCandidateStore(pool as never);
  const result = await store.decideCandidate("candidate-1", "accept");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "source_located_cannot_be_accepted");
  assert.equal(sqlCalls.some((sql) => sql.includes("UPDATE evidence_scout_candidate c SET state = $2")), false);
});
