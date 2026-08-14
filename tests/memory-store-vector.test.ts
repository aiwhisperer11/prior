import assert from "node:assert/strict";
import test from "node:test";

import { CockroachDBMemoryStore, LocalMemoryStore, MemoryLineageInvariantError, computeSourceId } from "../lib/server/memory-store";
import type { SherlockInvestigation } from "../types/sherlock";

function investigation(overrides: Partial<{ caseId: string; iteration: number; summary: string; caseTitle: string; domain: string }> = {}): SherlockInvestigation {
  const { caseId = "case-x", iteration = 1, summary = "s", caseTitle = "Case X", domain = "test" } = overrides;
  return {
    schema_version: "1.0.0",
    meta: { case_id: caseId, case_title: caseTitle, iteration, domain },
    case: { observed_outcome: "Observed", expected_behavior: "Expected", evidence: [{ id: "E1", label: "L", content: "C", provided_in_iteration: 1 }] },
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
  const store = new CockroachDBMemoryStore(pool as never, async () => ({ vector: [1, 2, 3], model: "fake" }));

  const results = await store.findSemanticPrecedents(
    { case_id: "current", case_title: "t", domain: "d", observed_outcome: "o", expected_behavior: "e", evidence: [] },
    "current",
  );

  assert.match(calls[0]!.sql, /ORDER BY embedding <-> \$1/);
  assert.match(calls[0]!.sql, /embedding IS NOT NULL/);
  assert.match(calls[0]!.sql, /case_id <> \$2/);
  assert.equal(calls[0]!.values[1], "current");
  assert.equal(results[0]?.similarityScore, 0.42);
});

test("CockroachDBMemoryStore.findLatestForCase queries by exact case_id (no exclusion) ordered to latest", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ id: "row-1", investigation_id: "inv-1", snapshot: investigation() }] }; } };
  const store = new CockroachDBMemoryStore(pool as never, async () => ({ vector: [1], model: "fake" }));

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
  const store = new CockroachDBMemoryStore(pool as never, async () => ({ vector: [1, 2], model: "fake-embed-model" }));
  const inv = investigation({ caseId: "case-new" });

  await store.save({ investigation: inv, isMock: false });

  const insertCall = calls.find((c) => /INSERT INTO investigation_memory/.test(c.sql));
  assert.ok(insertCall);
  assert.match(insertCall!.sql, /ON CONFLICT \(source_id\) WHERE source_id != '' DO NOTHING/);
  assert.equal(insertCall!.values.length, 13);
  assert.equal(insertCall!.values[9], "gpt-5.6-terra"); // model_version = OPENAI_MODEL
  assert.equal(insertCall!.values[12], "fake-embed-model"); // embedding_model
});
