import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { AuditArtifact, AuditStorage } from "../lib/server/audit-storage";
import { CockroachDBMemoryStore, LocalMemoryStore } from "../lib/server/memory-store";
import { LocalEvidenceScoutCandidateStore, resolveAcceptedCandidatesForFollowUp } from "../lib/server/evidence-scout-store";
import { prepareInvestigationRequest } from "../lib/server/sherlock-engine";
import type { SherlockInvestigation } from "../types/sherlock";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

class InMemoryAuditStorage implements AuditStorage {
  private readonly objects = new Map<string, string>();
  async putImmutable(key: string, content: string, contentType: string): Promise<AuditArtifact> {
    this.objects.set(key, content);
    return {
      key,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      contentType,
      verified: true,
      versionId: null,
      verifiedAt: "2026-08-16T00:00:00.000Z",
    };
  }
  async getImmutable(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }
}

const fakeEmbedder = async (text: string) => ({ vector: Array.from({ length: 4 }, (_, i) => text.length + i), model: "fake-embedder" });
const cloudflareExpected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");

async function acceptedCandidate(store: LocalEvidenceScoutCandidateStore, caseId: string): Promise<string> {
  const created = await store.createAction({
    caseId,
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the source",
    queries: ["query"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: `${caseId}-candidate`,
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("createAction failed");
  const claim = await store.claimAction(created.action.action_id);
  assert.equal(claim.claimed, true);
  await store.completeAction(created.action.action_id, claim.workerId, [{
    query: "query",
    publisher: "Cloudflare",
    documentTitle: "Details of the outage",
    sourceUrl: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
    claimSummary: "summary",
    citedText: "quoted",
    fragment: "quoted",
    publicationDate: null,
    tier: "official_primary",
    verificationStatus: "verified_as_published",
    sourceReliability: "high",
  }], 1);
  const action = await store.getAction(created.action.action_id);
  const candidateId = action?.candidates[0]?.candidate_id;
  assert.ok(candidateId);
  const decision = await store.decideCandidate(candidateId!, "accept");
  assert.equal(decision.ok, true);
  return candidateId!;
}

test("LocalMemoryStore treats a byte-identical follow-up retry as a successful no-op", async () => {
  const caseId = "case-local-follow-up-retry";
  const candidateStore = new LocalEvidenceScoutCandidateStore();
  const candidateId = await acceptedCandidate(candidateStore, caseId);
  const resolution = await resolveAcceptedCandidatesForFollowUp(candidateStore, caseId, [candidateId]);
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;

  const baselineInvestigation = { ...cloudflareExpected, meta: { ...cloudflareExpected.meta, case_id: caseId, iteration: 1 } };
  const prepared = prepareInvestigationRequest({
    previous_snapshot: baselineInvestigation,
    new_evidence: [],
  }, resolution.resolved);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const memoryStore = new LocalMemoryStore(fakeEmbedder, candidateStore);
  assert.equal(
    (globalThis as typeof globalThis & { __priorLocalEvidenceScoutStore?: unknown }).__priorLocalEvidenceScoutStore,
    undefined,
    "the injected candidate store must not require global registration",
  );
  await memoryStore.save({ investigation: baselineInvestigation, isMock: true });
  const investigation = {
    ...cloudflareExpected,
    meta: { ...cloudflareExpected.meta, case_id: caseId, iteration: 2 },
    case: { ...cloudflareExpected.case, evidence: prepared.request.evidence },
  };

  const first = await memoryStore.saveSnapshotWithEvidenceLinks({ investigation, isMock: true }, prepared.candidateLinks);
  const second = await memoryStore.saveSnapshotWithEvidenceLinks({ investigation, isMock: true }, prepared.candidateLinks);
  const candidateAfterFirst = await candidateStore.getCandidate(candidateId);
  const competing = await memoryStore.saveSnapshotWithEvidenceLinks({
    investigation: {
      ...investigation,
      learning: { ...investigation.learning, summary: `${investigation.learning.summary} competing-write` },
    },
    isMock: true,
  }, prepared.candidateLinks);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(candidateAfterFirst?.evidence_id, prepared.candidateLinks[0]?.evidenceId);
  assert.equal(candidateAfterFirst?.snapshot_id, first.snapshotId);
  assert.equal(candidateAfterFirst?.iteration, 2);
  assert.deepEqual(competing, { ok: false, code: "candidate_already_spent", candidateId });
});

test("CockroachDBMemoryStore treats a byte-identical follow-up retry as a successful no-op", async () => {
  const poolCalls: Array<{ sql: string; values?: unknown[] }> = [];
  const committedSnapshots = new Map<string, {
    id: string;
    case_id: string;
    investigation_id: string;
    parent_snapshot_id: string | null;
    source_id: string;
    model_version: string;
    prompt_version: string;
    embedding_model: string;
    snapshot: SherlockInvestigation;
    audit_artifact_key: string | null;
    audit_artifact_sha256: string | null;
    audit_artifact_backend: "local" | "s3" | null;
    audit_artifact_version_id: string | null;
    audit_artifact_verified_at: string | null;
    created_at: string;
  }>();
  const candidateState = {
    id: "candidate-1",
    state: "accepted",
    evidence_id: null as string | null,
    snapshot_id: null as string | null,
    iteration: null as number | null,
  };
  let txSnapshots = new Map<string, (typeof committedSnapshots extends Map<string, infer T> ? T : never)>();
  let inTransaction = false;

  function latestRowForCase(caseId: string) {
    const rows = [...committedSnapshots.values()].filter((row) => row.case_id === caseId);
    return rows.at(-1) ?? null;
  }

  function snapshotRow(values: unknown[]) {
    return {
      case_id: values[0] as string,
      investigation_id: values[6] as string,
      parent_snapshot_id: values[7] as string | null,
      source_id: values[8] as string,
      model_version: values[9] as string,
      prompt_version: values[10] as string,
      embedding_model: values[12] as string,
      id: values[13] as string,
      audit_artifact_key: values[14] as string | null,
      audit_artifact_sha256: values[15] as string | null,
      audit_artifact_backend: values[16] as "local" | "s3" | null,
      audit_artifact_version_id: values[17] as string | null,
      audit_artifact_verified_at: values[18] as string | null,
      snapshot: JSON.parse(values[5] as string) as SherlockInvestigation,
      created_at: `created-${committedSnapshots.size + txSnapshots.size + 1}`,
    };
  }

  function mergeVisibleSnapshots() {
    return new Map([...committedSnapshots, ...txSnapshots]);
  }

  function queryHandler(sql: string, values: unknown[] = []) {
    poolCalls.push({ sql, values });
    if (sql === "BEGIN") {
      inTransaction = true;
      txSnapshots = new Map();
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      for (const [sourceId, row] of txSnapshots) committedSnapshots.set(sourceId, row);
      txSnapshots = new Map();
      inTransaction = false;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      txSnapshots = new Map();
      inTransaction = false;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT id, investigation_id, parent_snapshot_id, source_id")) {
      const latest = latestRowForCase(values[0] as string);
      return { rows: latest ? [latest] : [], rowCount: latest ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO investigation_memory")) {
      const sourceId = values[8] as string;
      if (committedSnapshots.has(sourceId) || txSnapshots.has(sourceId)) return { rows: [], rowCount: 0 };
      const row = snapshotRow(values);
      if (inTransaction) txSnapshots.set(sourceId, row);
      else committedSnapshots.set(sourceId, row);
      return sql.includes("RETURNING id") ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT id FROM investigation_memory WHERE source_id = $1")) {
      const row = mergeVisibleSnapshots().get(values[0] as string);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE evidence_scout_candidate SET evidence_id = $1")) {
      if (candidateState.id === values[3] && candidateState.state === "accepted" && candidateState.evidence_id === null) {
        candidateState.evidence_id = values[0] as string;
        candidateState.snapshot_id = values[1] as string;
        candidateState.iteration = values[2] as number;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT id FROM evidence_scout_candidate")) {
      const matches =
        candidateState.id === values[0] &&
        candidateState.evidence_id === values[1] &&
        candidateState.snapshot_id === values[2] &&
        candidateState.iteration === values[3];
      return { rows: matches ? [{ id: candidateState.id }] : [], rowCount: matches ? 1 : 0 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  const client = {
    query: async (sql: string, values?: unknown[]) => queryHandler(sql, values),
    release() {},
  };
  const pool = {
    query: async (sql: string, values?: unknown[]) => queryHandler(sql, values),
    connect: async () => client,
  };

  const store = new CockroachDBMemoryStore(pool as never, new InMemoryAuditStorage(), fakeEmbedder);
  const caseId = "case-cockroach-follow-up-retry";
  const baselineInvestigation = { ...cloudflareExpected, meta: { ...cloudflareExpected.meta, case_id: caseId, iteration: 1 } };
  await store.save({ investigation: baselineInvestigation, isMock: false });

  const prepared = prepareInvestigationRequest({
    previous_snapshot: baselineInvestigation,
    new_evidence: [],
  }, [{
    candidateId: candidateState.id,
    label: "Details of the outage",
    content: "quoted",
    provenance: {
      evidence_type: "official_publication",
      publisher: "Cloudflare",
      document_title: "Details of the outage",
      source_url: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
      publication_date: null,
      retrieved_at: "2026-08-16T00:00:00.000Z",
      fragment: "quoted",
      cited_text: "quoted",
      claim_summary: "summary",
      human_accepted_at: "2026-08-16T00:00:00.000Z",
      verification_status: "verified_as_published",
      source_reliability: "high",
      search_lineage: { action_id: "action-1", query: "query", candidate_id: candidateState.id },
    },
  }]);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const investigation = {
    ...cloudflareExpected,
    meta: { ...cloudflareExpected.meta, case_id: caseId, iteration: 2 },
    case: { ...cloudflareExpected.case, evidence: prepared.request.evidence },
  };
  const candidateLinks = [{ candidateId: "candidate-1", evidenceId: "E12" }];

  const first = await store.saveSnapshotWithEvidenceLinks({ investigation, isMock: false }, candidateLinks);
  const second = await store.saveSnapshotWithEvidenceLinks({ investigation, isMock: false }, candidateLinks);
  const competing = await store.saveSnapshotWithEvidenceLinks({
    investigation: {
      ...investigation,
      learning: { ...investigation.learning, summary: `${investigation.learning.summary} competing-write` },
    },
    isMock: false,
  }, candidateLinks);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(candidateState.evidence_id, "E12");
  assert.equal(candidateState.snapshot_id, first.snapshotId);
  assert.equal(candidateState.iteration, 2);
  assert.deepEqual(competing, { ok: false, code: "candidate_already_spent", candidateId: "candidate-1" });
  assert.ok(poolCalls.some(({ sql }) => sql.includes("SELECT id FROM investigation_memory WHERE source_id = $1")));
  assert.ok(poolCalls.some(({ sql }) => sql.includes("SELECT id FROM evidence_scout_candidate")));
});
