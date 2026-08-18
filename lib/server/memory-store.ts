import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";

import { buildAuditArtifactEnvelope, buildAuditArtifactKey, computeArtifactSha256, serializeAuditArtifact, type RetrievedMemoryForAudit } from "@/lib/server/audit-artifact";
import { AuditIntegrityError, AuditStorageUnavailableError, S3AuditStorage, getAuditStorage, type AuditStorage } from "@/lib/server/audit-storage";
import { cockroachPoolOptions } from "@/lib/server/cockroach-pool";
import { embedText, l2Distance, type Embedder } from "@/lib/server/embeddings";
import { getLocalEvidenceScoutCandidateStoreIfActive, type CandidateEvidenceLinkInput, type LocalEvidenceScoutCandidateStore } from "@/lib/server/evidence-scout-store";
import { MemoryStoreUnavailableError } from "@/lib/server/memory-store-errors";
import { OPENAI_MODEL } from "@/lib/server/sherlock-engine";
import { canonicalize } from "@/lib/server/v2-snapshot-store";
import { PROMPT_VERSION } from "@/lib/sherlock-prompt";
import type { InvestigationRequest, SherlockInvestigation } from "@/types/sherlock";

// Re-exported for backward compatibility: existing importers (e.g.
// tests/memory-flow.test.ts, app/api/investigate/route.ts) use these names
// from this module. Their real definitions live in cockroach-pool.ts /
// memory-store-errors.ts specifically to let evidence-scout-store.ts (which
// this module also depends on, for saveSnapshotWithEvidenceLinks) import
// them without a circular dependency on this file.
export { cockroachPoolOptions, MemoryStoreUnavailableError };

export interface PrecedentLead {
  caseId: string;
  investigationId?: string;
  snapshotId?: string;
  sourceId?: string;
  iteration?: number;
  createdAt?: string;
  caseTitle: string;
  domain: string;
  summary: string;
  /** Only set when the store can report the persisted case text; required for suspected-duplicate fingerprinting. */
  observedOutcome?: string;
  expectedBehavior?: string;
  isMock: boolean;
  /** Only set by findSemanticPrecedents (vector path); undefined on the domain-recency path. */
  similarityScore?: number | null;
  /** Only set by findSemanticPrecedents; explains why this precedent was retrieved, derived from the retrieved record, never invented. */
  whyRelevant?: string;
}

export interface StoredInvestigation {
  investigation: SherlockInvestigation;
  isMock: boolean;
  /** Memory retrieved for this investigation and how it was classified (related/longitudinal/suspected-duplicate/unclassified) — embedded in the audit artifact envelope when the store writes one. Omitted entirely (not just empty) when the caller has no classification to report. */
  retrievedMemory?: RetrievedMemoryForAudit;
}

export interface LatestCaseSnapshot {
  snapshotId: string;
  investigationId: string;
  parentSnapshotId: string | null;
  sourceId: string;
  modelVersion: string;
  promptVersion: string;
  embeddingModel: string;
  snapshot: SherlockInvestigation;
  /**
   * Null exactly together, never independently: every row written before
   * this feature existed, and every row saved through LocalMemoryStore's dev
   * fallback (never wired to audit storage), honestly has none of these.
   * Never inferred as "verified" from anything else — a value here can only
   * exist because CockroachDBMemoryStore.save() already verified the
   * artifact in audit storage before persisting the row.
   */
  auditArtifactKey: string | null;
  auditArtifactSha256: string | null;
  /** Persisted per row at write time (not derived from the current store's configuration) — the backend that actually wrote this specific artifact. */
  auditStorageBackend: "local" | "s3" | null;
  /** The exact S3 object version this artifact was written as, when the bucket reports one. Always null for the "local" backend and for a bucket without versioning enabled. */
  auditArtifactVersionId: string | null;
  /** Server-stamped timestamp of when the write path finished verifying the artifact — not when the row was inserted. */
  auditArtifactVerifiedAt: string | null;
}

/**
 * A CockroachDB write failed after its audit artifact was already durably
 * written and verified in S3 (or local dev storage). The object is never
 * deleted (S3AuditStorage has no delete capability, by design — see
 * docs/aws-s3-audit-storage.md) and the investigation is never reported as
 * persisted. Callers must surface this distinctly: it is an orphaned,
 * reconcilable artifact, not a generic operational failure and not silent
 * success.
 */
export class OrphanedAuditArtifactError extends Error {
  constructor(public readonly artifactKey: string, public readonly artifactSha256: string, cause: unknown) {
    super(`The audit artifact for this investigation was durably written (key: ${artifactKey}) but the CockroachDB snapshot write failed afterward. The object was not deleted; it requires manual reconciliation.`, { cause });
  }
}

export interface InvestigationMemoryStore {
  findPrecedents(domain: string, excludeCaseId: string): Promise<PrecedentLead[]>;
  save(record: StoredInvestigation): Promise<void>;
}

export type SaveWithEvidenceLinksResult =
  | { ok: true; snapshotId: string }
  | { ok: false; code: "candidate_already_spent"; candidateId: string };

/**
 * Optional capability, detected via duck typing (same pattern as
 * SemanticCapableStore in investigation-flow.ts) so a plain
 * findPrecedents/save test double keeps satisfying InvestigationMemoryStore
 * unchanged. Both concrete stores below implement it.
 *
 * Point 5: snapshot insert + candidate link happen in a single transaction.
 * If linking ANY candidate fails -- point 6, a candidate can only be spent
 * once, enforced by a guarded UPDATE ... WHERE evidence_id IS NULL -- the
 * whole transaction rolls back, including the snapshot insert (point 14:
 * "rollback del snapshot si candidate link falla"). Never called when a
 * follow-up has no accepted_candidate_ids; plain save() remains the path for
 * every other write.
 */
export interface EvidenceLinkedMemoryStore extends InvestigationMemoryStore {
  saveSnapshotWithEvidenceLinks(record: StoredInvestigation, candidateLinks: CandidateEvidenceLinkInput[]): Promise<SaveWithEvidenceLinksResult>;
}

/**
 * Superset used by the vector-memory feature (semantic retrieval + case
 * continuation). Kept separate from InvestigationMemoryStore so existing
 * callers/tests that only need findPrecedents/save (e.g. runInvestigationFlow
 * and its tests) are unaffected — every concrete store below implements both.
 */
export interface SemanticMemoryStore extends InvestigationMemoryStore {
  /** Real CockroachDB Distributed Vector Indexing (`ORDER BY embedding <-> $1`) in production; a local L2-distance scan in dev. Never invents a similarity score or a relevance reason. */
  findSemanticPrecedents(request: InvestigationRequest, excludeCaseId: string, limit?: number): Promise<PrecedentLead[]>;
  /** The most recent persisted snapshot for this exact case_id (no exclusion) — the continuation lookup. */
  findLatestForCase(caseId: string): Promise<LatestCaseSnapshot | null>;
}

/** Prevents new writes from creating impossible lineage; it never rewrites historical rows. */
export class MemoryLineageInvariantError extends Error {}

function parentForNewSnapshot(iteration: number, prior: LatestCaseSnapshot | null): string | null {
  if (iteration === 1) return null;
  if (!prior?.snapshotId) throw new MemoryLineageInvariantError(`iteration ${iteration} requires a persisted parent snapshot`);
  return prior.snapshotId;
}

/** Idempotency key: a retried write for the same case_id/iteration/snapshot content is a no-op, not a duplicate. */
export function computeSourceId(caseId: string, iteration: number, investigation: SherlockInvestigation): string {
  return createHash("sha256").update(canonicalize({ caseId, iteration, investigation })).digest("hex");
}

function investigationEmbeddingText(investigation: SherlockInvestigation): string {
  return [investigation.meta.case_title, investigation.meta.domain, investigation.case.observed_outcome, investigation.case.expected_behavior, investigation.learning.summary]
    .filter((part) => part && part.trim())
    .join("\n");
}

function requestEmbeddingText(request: InvestigationRequest): string {
  return [request.case_title, request.domain, request.observed_outcome, request.expected_behavior].filter(Boolean).join("\n");
}

interface LocalRecord {
  investigation: SherlockInvestigation;
  sourceId: string;
  investigationId: string;
  snapshotId: string;
  parentSnapshotId: string | null;
  createdAt: string;
  embedding: number[];
  embeddingModel: string;
}

function compareLeadRecency(a: Pick<PrecedentLead, "iteration" | "createdAt" | "snapshotId">, b: Pick<PrecedentLead, "iteration" | "createdAt" | "snapshotId">): number {
  const iterationDelta = (a.iteration ?? Number.NEGATIVE_INFINITY) - (b.iteration ?? Number.NEGATIVE_INFINITY);
  if (iterationDelta !== 0) return iterationDelta;
  const createdAtDelta = Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "");
  if (!Number.isNaN(createdAtDelta) && createdAtDelta !== 0) return createdAtDelta;
  return (a.snapshotId ?? "").localeCompare(b.snapshotId ?? "");
}

function latestRecordPerCaseId(records: LocalRecord[]): LocalRecord[] {
  const deduped = new Map<string, LocalRecord>();
  for (const record of records) {
    const existing = deduped.get(record.investigation.meta.case_id);
    if (!existing || compareLeadRecency(localRecordRecency(record), localRecordRecency(existing)) > 0) deduped.set(record.investigation.meta.case_id, record);
  }
  return [...deduped.values()];
}

function localRecordRecency(record: LocalRecord): Pick<PrecedentLead, "iteration" | "createdAt" | "snapshotId"> {
  return { iteration: record.investigation.meta.iteration, createdAt: record.createdAt, snapshotId: record.snapshotId };
}

/**
 * Ephemeral development fallback. Its records are explicitly mock data.
 * findSemanticPrecedents here is a genuine in-process L2-distance scan over
 * real embeddings (the embedder is a real OpenAI call by default) — it is
 * NOT CockroachDB's Distributed Vector Indexing. This is a local
 * approximation of the *retrieval*, not a claim about the *index*:
 * unverified against live CockroachDB infra.
 */
export class LocalMemoryStore implements SemanticMemoryStore {
  private readonly records: LocalRecord[] = [];

  constructor(
    private readonly embedder: Embedder = (text) => embedText(text),
    private readonly evidenceScoutStore?: LocalEvidenceScoutCandidateStore,
  ) {}

  private candidateStore(): LocalEvidenceScoutCandidateStore | null {
    return this.evidenceScoutStore ?? getLocalEvidenceScoutCandidateStoreIfActive();
  }

  async findPrecedents(domain: string, excludeCaseId: string): Promise<PrecedentLead[]> {
    return latestRecordPerCaseId(
      this.records
      .filter((record) => record.investigation.meta.domain === domain && record.investigation.meta.case_id !== excludeCaseId)
    )
      .sort((a, b) => compareLeadRecency(localRecordRecency(b), localRecordRecency(a)))
      .slice(0, 3)
      .map((record) => this.toPrecedentLead(record));
  }

  async findSemanticPrecedents(request: InvestigationRequest, excludeCaseId: string, limit = 3): Promise<PrecedentLead[]> {
    const { vector } = await this.embedder(requestEmbeddingText(request));
    return latestRecordPerCaseId(
      this.records
      .filter((record) => record.investigation.meta.case_id !== excludeCaseId)
    )
      .map((record) => ({ record, distance: l2Distance(vector, record.embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map(({ record, distance }) => this.toPrecedentLead(record, distance));
  }

  async findLatestForCase(caseId: string): Promise<LatestCaseSnapshot | null> {
    const matches = this.records.filter((record) => record.investigation.meta.case_id === caseId);
    if (!matches.length) return null;
    const latest = matches[matches.length - 1]!;
    return {
      snapshotId: latest.snapshotId,
      investigationId: latest.investigationId,
      parentSnapshotId: latest.parentSnapshotId,
      sourceId: latest.sourceId,
      modelVersion: OPENAI_MODEL,
      promptVersion: PROMPT_VERSION,
      embeddingModel: latest.embeddingModel,
      snapshot: latest.investigation,
      // LocalMemoryStore is the ephemeral dev fallback and is never wired to
      // audit storage (see docs/aws-s3-audit-storage.md); rows saved through
      // it honestly never had an artifact, in dev exactly as in production.
      auditArtifactKey: null,
      auditArtifactSha256: null,
      auditStorageBackend: null,
      auditArtifactVersionId: null,
      auditArtifactVerifiedAt: null,
    };
  }

  async save({ investigation }: StoredInvestigation): Promise<void> {
    const sourceId = computeSourceId(investigation.meta.case_id, investigation.meta.iteration, investigation);
    if (this.records.some((record) => record.sourceId === sourceId)) return; // idempotent no-op
    const prior = await this.findLatestForCase(investigation.meta.case_id);
    const { vector, model } = await this.embedder(investigationEmbeddingText(investigation));
    this.records.push({
      investigation,
      sourceId,
      investigationId: prior?.investigationId ?? randomUUID(),
      snapshotId: randomUUID(),
      parentSnapshotId: parentForNewSnapshot(investigation.meta.iteration, prior),
      createdAt: new Date().toISOString(),
      embedding: vector,
      embeddingModel: model,
    });
  }

  /**
   * Dev/test equivalent of CockroachDBMemoryStore.saveSnapshotWithEvidenceLinks.
   * No real transaction exists for an in-memory store; atomicity is achieved
   * instead by a check-all-then-mutate-all pass with no `await` in between --
   * JS's single-threaded execution model means nothing else can interleave
   * between the check and the mutation, so this is genuinely atomic, not
   * merely convenient.
   */
  async saveSnapshotWithEvidenceLinks(record: StoredInvestigation, candidateLinks: CandidateEvidenceLinkInput[]): Promise<SaveWithEvidenceLinksResult> {
    const { investigation } = record;
    const sourceId = computeSourceId(investigation.meta.case_id, investigation.meta.iteration, investigation);
    const existing = this.records.find((r) => r.sourceId === sourceId);
    if (existing) {
      const candidateStore = candidateLinks.length > 0 ? this.candidateStore() : null;
      if (candidateLinks.length > 0 && !candidateStore) {
        throw new Error("saveSnapshotWithEvidenceLinks: no active LocalEvidenceScoutCandidateStore to link against");
      }
      for (const link of candidateLinks) {
        const candidate = candidateStore?.peekCandidateSync(link.candidateId);
        if (!candidate || candidate.evidence_id !== link.evidenceId || candidate.snapshot_id !== existing.snapshotId || candidate.iteration !== investigation.meta.iteration) {
          return { ok: false, code: "candidate_already_spent", candidateId: link.candidateId };
        }
      }
      return { ok: true, snapshotId: existing.snapshotId };
    }

    const snapshotId = randomUUID();
    if (candidateLinks.length > 0) {
      const candidateStore = this.candidateStore();
      if (!candidateStore) throw new Error("saveSnapshotWithEvidenceLinks: no active LocalEvidenceScoutCandidateStore to link against");
      for (const link of candidateLinks) {
        const candidate = candidateStore.peekCandidateSync(link.candidateId);
        if (!candidate || candidate.state !== "accepted" || candidate.evidence_id !== null) {
          return { ok: false, code: "candidate_already_spent", candidateId: link.candidateId };
        }
      }
      for (const link of candidateLinks) {
        candidateStore.trySpendCandidateSync(link.candidateId, link.evidenceId, snapshotId, investigation.meta.iteration);
      }
    }

    const prior = await this.findLatestForCase(investigation.meta.case_id);
    const { vector, model } = await this.embedder(investigationEmbeddingText(investigation));
    this.records.push({
      investigation,
      sourceId,
      investigationId: prior?.investigationId ?? randomUUID(),
      snapshotId,
      parentSnapshotId: parentForNewSnapshot(investigation.meta.iteration, prior),
      createdAt: new Date().toISOString(),
      embedding: vector,
      embeddingModel: model,
    });
    return { ok: true, snapshotId };
  }

  private toPrecedentLead(record: LocalRecord, distance?: number): PrecedentLead {
    return {
      caseId: record.investigation.meta.case_id,
      investigationId: record.investigationId,
      snapshotId: record.snapshotId,
      sourceId: record.sourceId,
      iteration: record.investigation.meta.iteration,
      createdAt: record.createdAt,
      caseTitle: record.investigation.meta.case_title,
      domain: record.investigation.meta.domain,
      summary: record.investigation.learning.summary,
      observedOutcome: record.investigation.case.observed_outcome,
      expectedBehavior: record.investigation.case.expected_behavior,
      isMock: true,
      similarityScore: distance ?? null,
      whyRelevant: distance === undefined
        ? `Same domain (${record.investigation.meta.domain}), most recent match.`
        : `Semantically closest prior investigation (L2 distance ${distance.toFixed(4)}) based on case title, domain, observed outcome, and expected behavior.`,
    };
  }
}

export class CockroachDBMemoryStore implements SemanticMemoryStore {
  private readonly auditStorageBackendLabel: "local" | "s3";

  /**
   * auditStorage has no default (unlike embedder): it is the one dependency
   * this store must never silently resolve from ambient environment state,
   * because doing so could make a test — or a stray call site — reach a
   * real S3 bucket depending on whatever AUDIT_STORAGE_BACKEND happens to be
   * set in the process's environment. Every call site, including
   * getMemoryStore() and every test, passes it explicitly.
   */
  constructor(private readonly pool: Pool, private readonly auditStorage: AuditStorage, private readonly embedder: Embedder = (text) => embedText(text)) {
    this.auditStorageBackendLabel = auditStorage instanceof S3AuditStorage ? "s3" : "local";
  }

  async findPrecedents(domain: string, excludeCaseId: string): Promise<PrecedentLead[]> {
    try {
      const result = await this.pool.query<{ case_id: string; investigation_id: string; snapshot_id: string; source_id: string; case_title: string; domain: string; summary: string; observed_outcome: string; expected_behavior: string; iteration: number; created_at: string }>(
        `WITH latest_per_case AS (
           SELECT case_id, investigation_id, id AS snapshot_id, source_id, case_title, domain, iteration, created_at,
                  snapshot->'learning'->>'summary' AS summary,
                  snapshot->'case'->>'observed_outcome' AS observed_outcome,
                  snapshot->'case'->>'expected_behavior' AS expected_behavior,
                  ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY iteration DESC, created_at DESC, id DESC) AS snapshot_rank
           FROM investigation_memory
           WHERE domain = $1 AND case_id <> $2
         )
         SELECT case_id, investigation_id, snapshot_id, source_id, case_title, domain, summary, observed_outcome, expected_behavior, iteration, created_at
         FROM latest_per_case
         WHERE snapshot_rank = 1
         ORDER BY created_at DESC, iteration DESC, snapshot_id DESC
         LIMIT 3`, [domain, excludeCaseId],
      );
      return result.rows.map((row) => ({ caseId: row.case_id, investigationId: row.investigation_id, snapshotId: row.snapshot_id, sourceId: row.source_id, iteration: row.iteration, createdAt: row.created_at, caseTitle: row.case_title, domain: row.domain, summary: row.summary, observedOutcome: row.observed_outcome, expectedBehavior: row.expected_behavior, isMock: false }));
    } catch (error) { throw new MemoryStoreUnavailableError(error); }
  }

  /** Real CockroachDB Distributed Vector Indexing query: `ORDER BY embedding <-> $1` (L2 distance, the only index-accelerated metric this preview feature supports). */
  async findSemanticPrecedents(request: InvestigationRequest, excludeCaseId: string, limit = 3): Promise<PrecedentLead[]> {
    try {
      const { vector } = await this.embedder(requestEmbeddingText(request));
      const result = await this.pool.query<{ case_id: string; investigation_id: string; snapshot_id: string; source_id: string; case_title: string; domain: string; summary: string; observed_outcome: string; expected_behavior: string; distance: number; iteration: number; created_at: string }>(
        `WITH latest_per_case AS (
           SELECT case_id, investigation_id, id AS snapshot_id, source_id, case_title, domain, iteration, created_at,
                  snapshot->'learning'->>'summary' AS summary,
                  snapshot->'case'->>'observed_outcome' AS observed_outcome,
                  snapshot->'case'->>'expected_behavior' AS expected_behavior,
                  embedding,
                  ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY iteration DESC, created_at DESC, id DESC) AS snapshot_rank
           FROM investigation_memory
           WHERE case_id <> $2 AND embedding IS NOT NULL
         )
         SELECT case_id, investigation_id, snapshot_id, source_id, case_title, domain, summary, observed_outcome, expected_behavior, iteration, created_at,
                embedding <-> $1 AS distance
         FROM latest_per_case
         WHERE snapshot_rank = 1
         ORDER BY embedding <-> $1
         LIMIT $3`,
        [JSON.stringify(vector), excludeCaseId, limit],
      );
      return result.rows.map((row) => ({
        caseId: row.case_id,
        investigationId: row.investigation_id,
        snapshotId: row.snapshot_id,
        sourceId: row.source_id,
        iteration: row.iteration,
        createdAt: row.created_at,
        caseTitle: row.case_title,
        domain: row.domain,
        summary: row.summary,
        observedOutcome: row.observed_outcome,
        expectedBehavior: row.expected_behavior,
        isMock: false,
        similarityScore: row.distance,
        whyRelevant: `Semantically closest prior investigation (L2 distance ${row.distance.toFixed(4)}) via CockroachDB's vector index, based on case title, domain, observed outcome, and expected behavior.`,
      }));
    } catch (error) { throw new MemoryStoreUnavailableError(error); }
  }

  async findLatestForCase(caseId: string): Promise<LatestCaseSnapshot | null> {
    try {
      const result = await this.pool.query<{
        id: string; investigation_id: string; parent_snapshot_id: string | null;
        source_id: string; model_version: string; prompt_version: string; embedding_model: string; snapshot: SherlockInvestigation;
        audit_artifact_key: string | null; audit_artifact_sha256: string | null;
        audit_artifact_backend: "local" | "s3" | null; audit_artifact_version_id: string | null; audit_artifact_verified_at: string | null;
      }>(
        `SELECT id, investigation_id, parent_snapshot_id, source_id, model_version, prompt_version, embedding_model, snapshot,
                audit_artifact_key, audit_artifact_sha256, audit_artifact_backend, audit_artifact_version_id, audit_artifact_verified_at
         FROM investigation_memory WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [caseId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        snapshotId: row.id,
        investigationId: row.investigation_id,
        parentSnapshotId: row.parent_snapshot_id,
        sourceId: row.source_id,
        modelVersion: row.model_version,
        promptVersion: row.prompt_version,
        embeddingModel: row.embedding_model,
        snapshot: row.snapshot,
        auditArtifactKey: row.audit_artifact_key,
        auditArtifactSha256: row.audit_artifact_sha256,
        // Read from the row itself (persisted per-write), not derived from
        // this store instance's current configuration — accurate even if
        // AUDIT_STORAGE_BACKEND changes between the row's write and this read.
        auditStorageBackend: row.audit_artifact_backend,
        auditArtifactVersionId: row.audit_artifact_version_id,
        auditArtifactVerifiedAt: row.audit_artifact_verified_at,
      };
    } catch (error) { throw new MemoryStoreUnavailableError(error); }
  }

  /**
   * Ordering is deliberate and load-bearing (see docs/aws-s3-audit-storage.md):
   * 1. build the audit artifact + sha256, entirely app-side, before any I/O;
   * 2. write and independently verify it in audit storage (S3 or local dev);
   * 3. persist the CockroachDB snapshot, including the artifact's key/hash.
   *
   * There is no distributed transaction across S3 and CockroachDB. If step 2
   * fails, nothing is persisted and nothing is reported as complete — no
   * silent fallback to local storage, no CockroachDB row written. If step 3
   * fails after step 2 already succeeded, the artifact is NOT deleted (this
   * store has no delete capability, by design) and the failure is reported
   * as OrphanedAuditArtifactError: an orphaned S3 object is auditable and
   * reconcilable by a human; a CockroachDB row claiming an artifact exists
   * when it does not would be worse.
   */
  async save({ investigation, isMock, retrievedMemory }: StoredInvestigation): Promise<void> {
    const prior = await this.findLatestForCase(investigation.meta.case_id);
    const sourceId = computeSourceId(investigation.meta.case_id, investigation.meta.iteration, investigation);
    const investigationId = prior?.investigationId ?? randomUUID();
    const snapshotId = randomUUID();
    const parentSnapshotId = parentForNewSnapshot(investigation.meta.iteration, prior);

    const envelope = buildAuditArtifactEnvelope({
      investigation,
      investigationId,
      snapshotId,
      parentSnapshotId,
      modelVersion: OPENAI_MODEL,
      promptVersion: PROMPT_VERSION,
      retrievedMemory: retrievedMemory ?? { related: [], longitudinal: [], suspectedDuplicates: [], unclassified: [] },
    });
    const serialized = serializeAuditArtifact(envelope);
    const sha256 = computeArtifactSha256(serialized);
    const key = buildAuditArtifactKey(investigation.meta.case_id, investigationId, snapshotId);

    let artifact;
    try {
      artifact = await this.auditStorage.putImmutable(key, serialized, "application/json");
    } catch (error) {
      if (error instanceof AuditIntegrityError || error instanceof AuditStorageUnavailableError) throw error;
      throw new AuditStorageUnavailableError(`Audit artifact ${key}: unexpected failure writing to audit storage.`, error);
    }
    // Defensive cross-check against the hash computed independently, here,
    // before the call: never trust putImmutable's returned hash on its own,
    // even though every AuditStorage implementation in this codebase already
    // verifies it internally.
    if (artifact.sha256 !== sha256) throw new AuditIntegrityError(`Audit artifact ${key}: audit storage returned sha256 ${artifact.sha256}, expected ${sha256}.`);

    try {
      const { vector, model } = await this.embedder(investigationEmbeddingText(investigation));
      await this.pool.query(
        `INSERT INTO investigation_memory
           (case_id, case_title, domain, iteration, is_mock, snapshot,
            investigation_id, parent_snapshot_id, source_id, model_version, prompt_version, embedding, embedding_model,
            id, audit_artifact_key, audit_artifact_sha256, audit_artifact_backend, audit_artifact_version_id, audit_artifact_verified_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (source_id) WHERE source_id != '' DO NOTHING`,
        [
          investigation.meta.case_id, investigation.meta.case_title, investigation.meta.domain, investigation.meta.iteration, isMock, JSON.stringify(investigation),
          investigationId, parentSnapshotId, sourceId, OPENAI_MODEL, PROMPT_VERSION, JSON.stringify(vector), model,
          snapshotId, artifact.key, artifact.sha256, this.auditStorageBackendLabel, artifact.versionId, artifact.verifiedAt,
        ],
      );
    } catch (error) {
      throw new OrphanedAuditArtifactError(artifact.key, artifact.sha256, error);
    }
  }

  /**
   * Point 5: the investigation_memory INSERT and every evidence_scout_candidate
   * link UPDATE happen inside one BEGIN/COMMIT on a single checked-out client.
   * The audit-artifact build+write (S3, or local dev storage) still happens
   * first and outside this transaction, exactly as in save() -- there is no
   * distributed transaction across S3 and CockroachDB, unchanged from the
   * existing documented ordering (see save()'s doc comment above).
   *
   * Each link UPDATE is guarded (`WHERE state = 'accepted' AND evidence_id
   * IS NULL`) -- point 6: a candidate can only be spent once. If ANY link
   * fails that guard (already spent by a racing follow-up), the whole
   * transaction rolls back, including the snapshot INSERT (point 14:
   * "rollback del snapshot si candidate link falla") -- the caller sees
   * `ok: false`, never a partially-persisted snapshot.
   */
  async saveSnapshotWithEvidenceLinks(
    { investigation, isMock, retrievedMemory }: StoredInvestigation,
    candidateLinks: CandidateEvidenceLinkInput[],
  ): Promise<SaveWithEvidenceLinksResult> {
    const prior = await this.findLatestForCase(investigation.meta.case_id);
    const sourceId = computeSourceId(investigation.meta.case_id, investigation.meta.iteration, investigation);
    const investigationId = prior?.investigationId ?? randomUUID();
    const snapshotId = randomUUID();
    const parentSnapshotId = parentForNewSnapshot(investigation.meta.iteration, prior);

    const envelope = buildAuditArtifactEnvelope({
      investigation,
      investigationId,
      snapshotId,
      parentSnapshotId,
      modelVersion: OPENAI_MODEL,
      promptVersion: PROMPT_VERSION,
      retrievedMemory: retrievedMemory ?? { related: [], longitudinal: [], suspectedDuplicates: [], unclassified: [] },
    });
    const serialized = serializeAuditArtifact(envelope);
    const sha256 = computeArtifactSha256(serialized);
    const key = buildAuditArtifactKey(investigation.meta.case_id, investigationId, snapshotId);

    let artifact;
    try {
      artifact = await this.auditStorage.putImmutable(key, serialized, "application/json");
    } catch (error) {
      if (error instanceof AuditIntegrityError || error instanceof AuditStorageUnavailableError) throw error;
      throw new AuditStorageUnavailableError(`Audit artifact ${key}: unexpected failure writing to audit storage.`, error);
    }
    if (artifact.sha256 !== sha256) throw new AuditIntegrityError(`Audit artifact ${key}: audit storage returned sha256 ${artifact.sha256}, expected ${sha256}.`);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { vector, model } = await this.embedder(investigationEmbeddingText(investigation));
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO investigation_memory
           (case_id, case_title, domain, iteration, is_mock, snapshot,
            investigation_id, parent_snapshot_id, source_id, model_version, prompt_version, embedding, embedding_model,
            id, audit_artifact_key, audit_artifact_sha256, audit_artifact_backend, audit_artifact_version_id, audit_artifact_verified_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (source_id) WHERE source_id != '' DO NOTHING
         RETURNING id`,
        [
          investigation.meta.case_id, investigation.meta.case_title, investigation.meta.domain, investigation.meta.iteration, isMock, JSON.stringify(investigation),
          investigationId, parentSnapshotId, sourceId, OPENAI_MODEL, PROMPT_VERSION, JSON.stringify(vector), model,
          snapshotId, artifact.key, artifact.sha256, this.auditStorageBackendLabel, artifact.versionId, artifact.verifiedAt,
        ],
      );
      let persistedSnapshotId = inserted.rows[0]?.id ?? null;
      if (persistedSnapshotId === null) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM investigation_memory WHERE source_id = $1`,
          [sourceId],
        );
        persistedSnapshotId = existing.rows[0]?.id ?? null;
        if (persistedSnapshotId === null) throw new Error(`investigation_memory row for source_id ${sourceId} disappeared during idempotent retry`);
        for (const link of candidateLinks) {
          const linked = await client.query<{ id: string }>(
            `SELECT id FROM evidence_scout_candidate
             WHERE id = $1 AND evidence_id = $2 AND snapshot_id = $3 AND iteration = $4`,
            [link.candidateId, link.evidenceId, persistedSnapshotId, investigation.meta.iteration],
          );
          if ((linked.rowCount ?? 0) === 0) {
            await client.query("ROLLBACK");
            return { ok: false, code: "candidate_already_spent", candidateId: link.candidateId };
          }
        }
        await client.query("COMMIT");
        return { ok: true, snapshotId: persistedSnapshotId };
      }

      for (const link of candidateLinks) {
        const updated = await client.query(
          `UPDATE evidence_scout_candidate SET evidence_id = $1, snapshot_id = $2, iteration = $3
           WHERE id = $4 AND state = 'accepted' AND evidence_id IS NULL`,
          [link.evidenceId, persistedSnapshotId, investigation.meta.iteration, link.candidateId],
        );
        if (updated.rowCount === 0) {
          await client.query("ROLLBACK");
          return { ok: false, code: "candidate_already_spent", candidateId: link.candidateId };
        }
      }

      await client.query("COMMIT");
      return { ok: true, snapshotId: persistedSnapshotId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new OrphanedAuditArtifactError(artifact.key, artifact.sha256, error);
    } finally {
      client.release();
    }
  }
}

type MemoryStoreGlobals = typeof globalThis & { __priorLocalStore?: LocalMemoryStore; __priorCockroachStore?: CockroachDBMemoryStore };
const stores = globalThis as MemoryStoreGlobals;

/**
 * DATABASE_URL is read only on the server and never exposed to the client.
 * Both branches use the real OpenAI embedder by default — only the vector
 * *index* is simulated (LocalMemoryStore's in-process scan), never the
 * embedding call itself.
 */
export function getMemoryStore(): SemanticMemoryStore {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return stores.__priorLocalStore ??= new LocalMemoryStore();
  if (!stores.__priorCockroachStore) stores.__priorCockroachStore = new CockroachDBMemoryStore(new Pool(cockroachPoolOptions(databaseUrl)), getAuditStorage());
  return stores.__priorCockroachStore;
}
