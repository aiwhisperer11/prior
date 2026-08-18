import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { cockroachPoolOptions } from "@/lib/server/cockroach-pool";
import type {
  CandidateTier,
  CandidateVerificationStatus,
  EligibleCandidateVerificationStatus,
  EvidenceProvenance,
  EvidenceScoutAction,
  EvidenceScoutActionWithCandidates,
  EvidenceScoutCandidateDecision,
  EvidenceScoutFailureCode,
  SourceCandidate,
  SourceReliability,
} from "@/types/evidence-scout";

/** Lambda timeout (90s) + a safety margin; must stay >= the Lambda timeout so a genuinely in-flight attempt is never mistaken for abandoned. See infra/evidence-scout-lambda/template.yaml. */
export const CLAIM_LEASE_SECONDS = 120;
/** Hard ceiling shared by the DB-level attempt_count CHECK and SQS's redrive maxReceiveCount (infra/evidence-scout-lambda/template.yaml) -- kept as one named constant so the two never drift apart. */
export const MAX_ATTEMPTS = 3;

export interface CreateActionInput {
  caseId: string;
  investigationId: string | null;
  missingEvidenceId: string | null;
  queryIntent: string;
  queries: string[];
  maxCandidates: number;
  allowedDomains: string[] | null;
  idempotencyKey: string | null;
}

export type CreateActionResult =
  | { ok: true; action: EvidenceScoutAction; shouldDispatch: boolean }
  | { ok: false; code: "daily_budget_exceeded" | "case_not_allowlisted" | "invalid_input"; message: string }
  /** Retryable, distinct from a terminal rejection: the caller (the API route) may retry once, never silently. */
  | { ok: false; code: "retryable"; message: string };

export interface ClaimResult {
  claimed: boolean;
  workerId: string;
  action: EvidenceScoutAction | null;
}

export interface NewCandidateInput {
  query: string;
  publisher: string | null;
  documentTitle: string | null;
  sourceUrl: string;
  claimSummary: string;
  citedText: string | null;
  fragment: string | null;
  publicationDate: string | null;
  tier: CandidateTier;
  verificationStatus: CandidateVerificationStatus;
  sourceReliability: SourceReliability;
}

export type DecideCandidateResult =
  | { ok: true; candidate: SourceCandidate }
  | { ok: false; code: "not_found" | "already_decided_differently" | "source_located_cannot_be_accepted" };

/** Consumed by CockroachDBMemoryStore.saveSnapshotWithEvidenceLinks / LocalMemoryStore's equivalent (memory-store.ts) -- the single-transaction snapshot-insert + candidate-link step (point 5). */
export interface CandidateEvidenceLinkInput {
  candidateId: string;
  evidenceId: string;
}

export interface ResolvedAcceptedCandidate {
  candidateId: string;
  label: string;
  content: string;
  provenance: EvidenceProvenance;
}

export type ResolveAcceptedCandidatesResult =
  | { ok: true; resolved: ResolvedAcceptedCandidate[] }
  | { ok: false; message: string };

/**
 * Durable state machine for search actions and their candidates. A
 * source_candidate is never an EvidenceItem; only decideCandidate("accept")
 * on an eligible (never source_located -- point 8) candidate can ever
 * become one, and only via the single-transaction snapshot+link path in
 * CockroachDBMemoryStore.saveSnapshotWithEvidenceLinks -- this interface
 * never mints an evidence_id itself.
 */
export interface EvidenceScoutCandidateStore {
  createAction(input: CreateActionInput): Promise<CreateActionResult>;
  getAction(actionId: string): Promise<EvidenceScoutActionWithCandidates | null>;
  claimAction(actionId: string): Promise<ClaimResult>;
  completeAction(actionId: string, workerId: string, candidates: NewCandidateInput[], searchCallCount: number): Promise<{ ok: boolean }>;
  failAction(actionId: string, workerId: string, failureCode: EvidenceScoutFailureCode): Promise<{ ok: boolean }>;
  /** Dispatch failure recoverable (point 14): the SQS send itself failed, before any worker ever claimed the action -- authorized -> failed directly, never requiring a lease. */
  markDispatchFailed(actionId: string): Promise<{ ok: boolean }>;
  getCandidate(candidateId: string): Promise<SourceCandidate | null>;
  decideCandidate(candidateId: string, decision: EvidenceScoutCandidateDecision): Promise<DecideCandidateResult>;
}

function canAcceptCandidate(candidate: Pick<SourceCandidate, "verification_status">): boolean {
  return candidate.verification_status !== "source_located";
}

function shouldDispatchExistingAction(action: EvidenceScoutAction): boolean {
  return action.state === "authorized";
}

const EVIDENCE_TYPE_BY_TIER: Record<CandidateTier, EvidenceProvenance["evidence_type"]> = {
  official_primary: "official_publication",
  institutional: "institutional_documentation",
  reputable_secondary: "reputable_secondary",
  other: "other",
};

/**
 * Point 8, enforced here (not just at the DB CHECK level): a source_located
 * candidate can never be resolved into evidence. Shared by both store
 * implementations so the rule cannot drift between them.
 */
export async function resolveAcceptedCandidatesForFollowUp(
  store: EvidenceScoutCandidateStore,
  caseId: string,
  candidateIds: string[],
): Promise<ResolveAcceptedCandidatesResult> {
  const resolved: ResolvedAcceptedCandidate[] = [];
  for (const candidateId of candidateIds) {
    const candidate = await store.getCandidate(candidateId);
    if (!candidate) return { ok: false, message: `accepted_candidate_ids references unknown candidate ${candidateId}` };
    if (candidate.case_id !== caseId) return { ok: false, message: `candidate ${candidateId} does not belong to case ${caseId}` };
    if (candidate.state !== "accepted") return { ok: false, message: `candidate ${candidateId} is not accepted (state: ${candidate.state})` };
    if (candidate.evidence_id !== null) return { ok: false, message: `candidate ${candidateId} was already incorporated as evidence ${candidate.evidence_id}` };
    if (candidate.verification_status === "source_located") {
      return { ok: false, message: `candidate ${candidateId} is source_located; only citation_supported or verified_as_published candidates can become evidence` };
    }
    const eligibleStatus = candidate.verification_status as EligibleCandidateVerificationStatus;
    if (!candidate.fragment) return { ok: false, message: `candidate ${candidateId} has no fragment; cannot become evidence` };
    if (!candidate.decided_at) return { ok: false, message: `candidate ${candidateId} has no acceptance timestamp` };
    resolved.push({
      candidateId,
      label: candidate.document_title ?? candidate.publisher ?? `Evidence Scout candidate ${candidateId}`,
      content: candidate.cited_text ?? candidate.fragment,
      provenance: {
        evidence_type: EVIDENCE_TYPE_BY_TIER[candidate.tier],
        publisher: candidate.publisher,
        document_title: candidate.document_title,
        source_url: candidate.source_url,
        publication_date: null,
        retrieved_at: candidate.retrieved_at,
        fragment: candidate.fragment,
        cited_text: candidate.cited_text,
        claim_summary: candidate.claim_summary,
        human_accepted_at: candidate.decided_at,
        verification_status: eligibleStatus,
        source_reliability: candidate.source_reliability,
        search_lineage: { action_id: candidate.action_id, query: candidate.query, candidate_id: candidateId },
      },
    });
  }
  // Exact duplicates within one request are rejected outright, same
  // discipline as user_hypotheses's input-hygiene check -- never silently
  // deduplicated.
  if (new Set(candidateIds).size !== candidateIds.length) {
    return { ok: false, message: "accepted_candidate_ids contains a duplicate id" };
  }
  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Local (in-memory) implementation -- dev/test only, never production.
// ---------------------------------------------------------------------------

interface LocalActionRecord extends EvidenceScoutAction {
  candidates: SourceCandidate[];
  idempotencyKey: string | null;
  leasedBy: string | null;
  leasedUntil: string | null;
}

export class LocalEvidenceScoutCandidateStore implements EvidenceScoutCandidateStore {
  private readonly actions = new Map<string, LocalActionRecord>();
  private nextCandidateNumber = 1;

  constructor(private readonly dailyLimit: number = Number(process.env.EVIDENCE_SCOUT_DAILY_ACTION_LIMIT ?? "20")) {}

  async createAction(input: CreateActionInput): Promise<CreateActionResult> {
    if (input.idempotencyKey) {
      const existing = [...this.actions.values()].find((a) => a.case_id === input.caseId && a.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.state === "failed" && existing.failure_code === "dispatch_failed") {
          existing.state = "authorized";
          existing.failure_code = null;
          existing.completed_at = null;
        }
        const action = stripInternal(existing);
        return { ok: true, action, shouldDispatch: shouldDispatchExistingAction(action) };
      }
    }
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const usedToday = [...this.actions.values()].filter((a) => new Date(a.authorized_at) >= today).length;
    if (usedToday >= this.dailyLimit) return { ok: false, code: "daily_budget_exceeded", message: `daily evidence-scout action limit (${this.dailyLimit}) reached` };

    const id = randomUUID();
    const record: LocalActionRecord = {
      action_id: id,
      case_id: input.caseId,
      investigation_id: input.investigationId,
      missing_evidence_id: input.missingEvidenceId,
      query_intent: input.queryIntent,
      queries: input.queries,
      max_candidates: input.maxCandidates,
      allowed_domains: input.allowedDomains,
      state: "authorized",
      authorized_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      failure_code: null,
      search_call_count: 0,
      attempt_count: 0,
      candidates: [],
      idempotencyKey: input.idempotencyKey,
      leasedBy: null,
      leasedUntil: null,
    };
    this.actions.set(id, record);
    return { ok: true, action: stripInternal(record), shouldDispatch: true };
  }

  async getAction(actionId: string): Promise<EvidenceScoutActionWithCandidates | null> {
    const record = this.actions.get(actionId);
    if (!record) return null;
    this.reapIfExpired(record);
    return { ...stripInternal(record), candidates: record.candidates };
  }

  private reapIfExpired(record: LocalActionRecord): void {
    if (record.state !== "searching" || !record.leasedUntil) return;
    if (new Date(record.leasedUntil) < new Date() && record.attempt_count >= MAX_ATTEMPTS) {
      record.state = "failed";
      record.failure_code = "max_attempts_exceeded";
      record.completed_at = new Date().toISOString();
      record.leasedBy = null;
      record.leasedUntil = null;
    }
  }

  async claimAction(actionId: string): Promise<ClaimResult> {
    const workerId = randomUUID();
    const record = this.actions.get(actionId);
    if (!record) return { claimed: false, workerId, action: null };
    this.reapIfExpired(record);
    const leaseExpired = record.state === "searching" && typeof record.leasedUntil === "string" && new Date(record.leasedUntil) < new Date();
    const claimable = (record.state === "authorized" || leaseExpired) && record.attempt_count < MAX_ATTEMPTS;
    if (!claimable) return { claimed: false, workerId, action: stripInternal(record) };
    record.state = "searching";
    record.leasedBy = workerId;
    record.leasedUntil = new Date(Date.now() + CLAIM_LEASE_SECONDS * 1000).toISOString();
    record.attempt_count += 1;
    record.started_at ??= new Date().toISOString();
    return { claimed: true, workerId, action: stripInternal(record) };
  }

  async completeAction(actionId: string, workerId: string, candidates: NewCandidateInput[], searchCallCount: number): Promise<{ ok: boolean }> {
    const record = this.actions.get(actionId);
    if (!record || record.state !== "searching" || record.leasedBy !== workerId) return { ok: false };
    record.candidates = candidates.map((c) => ({
      candidate_id: `C${this.nextCandidateNumber++}`,
      action_id: actionId,
      case_id: record.case_id,
      query: c.query,
      publisher: c.publisher,
      document_title: c.documentTitle,
      source_url: c.sourceUrl,
      claim_summary: c.claimSummary,
      cited_text: c.citedText,
      fragment: c.fragment,
      tier: c.tier,
      verification_status: c.verificationStatus,
      source_reliability: c.sourceReliability,
      retrieved_at: new Date().toISOString(),
      state: "pending",
      decided_at: null,
      evidence_id: null,
      snapshot_id: null,
      iteration: null,
    }));
    record.state = "completed";
    record.completed_at = new Date().toISOString();
    record.search_call_count = searchCallCount;
    record.leasedBy = null;
    record.leasedUntil = null;
    return { ok: true };
  }

  async failAction(actionId: string, workerId: string, failureCode: EvidenceScoutFailureCode): Promise<{ ok: boolean }> {
    const record = this.actions.get(actionId);
    if (!record || record.state !== "searching" || record.leasedBy !== workerId) return { ok: false };
    record.state = "failed";
    record.failure_code = failureCode;
    record.completed_at = new Date().toISOString();
    record.leasedBy = null;
    record.leasedUntil = null;
    return { ok: true };
  }

  async markDispatchFailed(actionId: string): Promise<{ ok: boolean }> {
    const record = this.actions.get(actionId);
    if (!record || record.state !== "authorized") return { ok: false };
    record.state = "failed";
    record.failure_code = "dispatch_failed";
    record.completed_at = new Date().toISOString();
    return { ok: true };
  }

  async getCandidate(candidateId: string): Promise<SourceCandidate | null> {
    for (const record of this.actions.values()) {
      const candidate = record.candidates.find((c) => c.candidate_id === candidateId);
      if (candidate) return candidate;
    }
    return null;
  }

  async decideCandidate(candidateId: string, decision: EvidenceScoutCandidateDecision): Promise<DecideCandidateResult> {
    for (const record of this.actions.values()) {
      const candidate = record.candidates.find((c) => c.candidate_id === candidateId);
      if (!candidate) continue;
      const targetState = decision === "accept" ? "accepted" : "rejected";
      if (decision === "accept" && !canAcceptCandidate(candidate)) return { ok: false, code: "source_located_cannot_be_accepted" };
      if (candidate.state === targetState) return { ok: true, candidate }; // idempotent no-op
      if (candidate.state !== "pending") return { ok: false, code: "already_decided_differently" };
      candidate.state = targetState;
      candidate.decided_at = new Date().toISOString();
      return { ok: true, candidate };
    }
    return { ok: false, code: "not_found" };
  }

  /** Synchronous read for LocalMemoryStore.saveSnapshotWithEvidenceLinks's check-all-then-mutate-all two-pass atomicity (memory-store.ts). */
  peekCandidateSync(candidateId: string): SourceCandidate | null {
    for (const record of this.actions.values()) {
      const candidate = record.candidates.find((c) => c.candidate_id === candidateId);
      if (candidate) return candidate;
    }
    return null;
  }

  /** Test/dev-only synchronous "spend" used by LocalMemoryStore.saveSnapshotWithEvidenceLinks -- see that method for why this must run with no await between the check and the mutation. */
  trySpendCandidateSync(candidateId: string, evidenceId: string, snapshotId: string, iteration: number): boolean {
    for (const record of this.actions.values()) {
      const candidate = record.candidates.find((c) => c.candidate_id === candidateId);
      if (!candidate) continue;
      if (candidate.state !== "accepted" || candidate.evidence_id !== null) return false;
      candidate.evidence_id = evidenceId;
      candidate.snapshot_id = snapshotId;
      candidate.iteration = iteration;
      return true;
    }
    return false;
  }
}

function stripInternal(record: LocalActionRecord): EvidenceScoutAction {
  return {
    action_id: record.action_id,
    case_id: record.case_id,
    investigation_id: record.investigation_id,
    missing_evidence_id: record.missing_evidence_id,
    query_intent: record.query_intent,
    queries: record.queries,
    max_candidates: record.max_candidates,
    allowed_domains: record.allowed_domains,
    state: record.state,
    authorized_at: record.authorized_at,
    started_at: record.started_at,
    completed_at: record.completed_at,
    failure_code: record.failure_code,
    search_call_count: record.search_call_count,
    attempt_count: record.attempt_count,
  } satisfies EvidenceScoutAction;
}

// ---------------------------------------------------------------------------
// CockroachDB implementation -- production.
// ---------------------------------------------------------------------------

interface ActionRow {
  id: string; case_id: string; investigation_id: string | null; missing_evidence_id: string | null;
  query_intent: string; queries: string[]; max_candidates: number; allowed_domains: string[] | null;
  state: EvidenceScoutAction["state"]; authorized_at: string; started_at: string | null; completed_at: string | null;
  failure_code: EvidenceScoutFailureCode | null; search_call_count: number; attempt_count: number;
}

function mapActionRow(row: ActionRow): EvidenceScoutAction {
  return {
    action_id: row.id,
    case_id: row.case_id,
    investigation_id: row.investigation_id,
    missing_evidence_id: row.missing_evidence_id,
    query_intent: row.query_intent,
    queries: row.queries,
    max_candidates: row.max_candidates,
    allowed_domains: row.allowed_domains,
    state: row.state,
    authorized_at: row.authorized_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    failure_code: row.failure_code,
    search_call_count: row.search_call_count,
    attempt_count: row.attempt_count,
  };
}

interface CandidateRow {
  id: string; action_id: string; case_id: string; query: string; publisher: string | null; document_title: string | null;
  source_url: string; claim_summary: string; cited_text: string | null; fragment: string | null;
  tier: CandidateTier; state: SourceCandidate["state"]; verification_status: CandidateVerificationStatus;
  source_reliability: SourceReliability; retrieved_at: string; decided_at: string | null;
  evidence_id: string | null; snapshot_id: string | null; iteration: number | null;
}

function mapCandidateRow(row: CandidateRow): SourceCandidate {
  return {
    candidate_id: row.id,
    action_id: row.action_id,
    case_id: row.case_id,
    query: row.query,
    publisher: row.publisher,
    document_title: row.document_title,
    source_url: row.source_url,
    claim_summary: row.claim_summary,
    cited_text: row.cited_text,
    fragment: row.fragment,
    tier: row.tier,
    verification_status: row.verification_status,
    source_reliability: row.source_reliability,
    retrieved_at: row.retrieved_at,
    state: row.state,
    decided_at: row.decided_at,
    evidence_id: row.evidence_id,
    snapshot_id: row.snapshot_id,
    iteration: row.iteration,
  };
}

/** Postgres/CockroachDB SQLSTATE for a serialization failure -- retryable, never a terminal error. */
function isSerializationFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "40001");
}

export class CockroachDBEvidenceScoutCandidateStore implements EvidenceScoutCandidateStore {
  constructor(
    private readonly pool: Pool,
    private readonly dailyLimit: number = Number(process.env.EVIDENCE_SCOUT_DAILY_ACTION_LIMIT ?? "20"),
    private readonly caseAllowlist: string[] | null = process.env.EVIDENCE_SCOUT_CASE_ALLOWLIST?.trim()
      ? process.env.EVIDENCE_SCOUT_CASE_ALLOWLIST.split(",").map((s) => s.trim())
      : null,
  ) {}

  /**
   * Daily budget in a serializable transaction (point: "daily budget en
   * transacción serializable"). CockroachDB only ever runs at SERIALIZABLE
   * isolation (it has no weaker level), so a plain BEGIN/COMMIT around the
   * count-then-insert is already a real atomic guarantee, not best-effort --
   * a genuine conflict surfaces as SQLSTATE 40001, which this method
   * reports as a retryable failure rather than silently racing.
   */
  async createAction(input: CreateActionInput): Promise<CreateActionResult> {
    if (this.caseAllowlist && !this.caseAllowlist.includes(input.caseId)) {
      return { ok: false, code: "case_not_allowlisted", message: `case_id "${input.caseId}" is not on EVIDENCE_SCOUT_CASE_ALLOWLIST` };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (input.idempotencyKey) {
        const existing = await client.query<ActionRow>(
          `SELECT id, case_id, investigation_id, missing_evidence_id, query_intent, queries, max_candidates, allowed_domains, state, authorized_at, started_at, completed_at, failure_code, search_call_count, attempt_count
           FROM evidence_scout_action WHERE case_id = $1 AND idempotency_key = $2`,
          [input.caseId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          let actionRow = existing.rows[0];
          if (actionRow.state === "failed" && actionRow.failure_code === "dispatch_failed") {
            const revived = await client.query<ActionRow>(
              `UPDATE evidence_scout_action
               SET state = 'authorized', failure_code = NULL, completed_at = NULL
               WHERE id = $1 AND state = 'failed' AND failure_code = 'dispatch_failed'
               RETURNING id, case_id, investigation_id, missing_evidence_id, query_intent, queries, max_candidates, allowed_domains, state, authorized_at, started_at, completed_at, failure_code, search_call_count, attempt_count`,
              [actionRow.id],
            );
            actionRow = revived.rows[0] ?? actionRow;
          }
          await client.query("COMMIT");
          const action = mapActionRow(actionRow);
          return { ok: true, action, shouldDispatch: shouldDispatchExistingAction(action) };
        }
      }
      const { rows: [{ count }] } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM evidence_scout_action WHERE created_at >= date_trunc('day', now())`,
      );
      if (Number(count) >= this.dailyLimit) {
        await client.query("ROLLBACK");
        return { ok: false, code: "daily_budget_exceeded", message: `daily evidence-scout action limit (${this.dailyLimit}) reached` };
      }
      const { rows: [row] } = await client.query<ActionRow>(
        `INSERT INTO evidence_scout_action
           (case_id, investigation_id, missing_evidence_id, query_intent, queries, max_candidates, allowed_domains, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, case_id, investigation_id, missing_evidence_id, query_intent, queries, max_candidates, allowed_domains, state, authorized_at, started_at, completed_at, failure_code, search_call_count, attempt_count`,
        [input.caseId, input.investigationId, input.missingEvidenceId, input.queryIntent, input.queries, input.maxCandidates, input.allowedDomains, input.idempotencyKey],
      );
      await client.query("COMMIT");
      const action = mapActionRow(row as ActionRow);
      return { ok: true, action, shouldDispatch: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (isSerializationFailure(error)) return { ok: false, code: "retryable", message: "transient serialization conflict; retry once" };
      throw error;
    } finally {
      client.release();
    }
  }

  async getAction(actionId: string): Promise<EvidenceScoutActionWithCandidates | null> {
    // Lazy reap: an expired lease with attempts exhausted is repaired to
    // 'failed' on read, no cron required.
    await this.pool.query(
      `UPDATE evidence_scout_action SET state = 'failed', failure_code = 'max_attempts_exceeded', completed_at = now()
       , leased_by = NULL, leased_until = NULL
       WHERE id = $1 AND state = 'searching' AND leased_until < now() AND attempt_count >= $2`,
      [actionId, MAX_ATTEMPTS],
    );
    const actionResult = await this.pool.query<ActionRow>(
      `SELECT id, case_id, investigation_id, missing_evidence_id, query_intent, queries, max_candidates, allowed_domains, state, authorized_at, started_at, completed_at, failure_code, search_call_count, attempt_count
       FROM evidence_scout_action WHERE id = $1`,
      [actionId],
    );
    const row = actionResult.rows[0];
    if (!row) return null;
    const candidatesResult = await this.pool.query<CandidateRow>(
      `SELECT c.id, c.action_id, a.case_id, c.query, c.publisher, c.document_title, c.source_url, c.claim_summary, c.cited_text, c.fragment,
              c.tier, c.state, c.verification_status, c.source_reliability, c.retrieved_at, c.decided_at, c.evidence_id, c.snapshot_id, c.iteration
       FROM evidence_scout_candidate c JOIN evidence_scout_action a ON a.id = c.action_id
       WHERE c.action_id = $1 ORDER BY c.created_at ASC`,
      [actionId],
    );
    return { ...mapActionRow(row), candidates: candidatesResult.rows.map(mapCandidateRow) };
  }

  async claimAction(actionId: string): Promise<ClaimResult> {
    const workerId = randomUUID();
    const result = await this.pool.query<ActionRow>(
      `UPDATE evidence_scout_action
       SET state = 'searching', leased_by = $2, leased_until = now() + ($3 || ' seconds')::interval,
           attempt_count = attempt_count + 1, started_at = COALESCE(started_at, now())
       WHERE id = $1
         AND (state = 'authorized' OR (state = 'searching' AND leased_until < now()))
         AND attempt_count < $4
       RETURNING id, case_id, investigation_id, missing_evidence_id, query_intent, queries, max_candidates, allowed_domains, state, authorized_at, started_at, completed_at, failure_code, search_call_count, attempt_count`,
      [actionId, workerId, CLAIM_LEASE_SECONDS, MAX_ATTEMPTS],
    );
    const row = result.rows[0];
    return { claimed: Boolean(row), workerId, action: row ? mapActionRow(row) : null };
  }

  async completeAction(actionId: string, workerId: string, candidates: NewCandidateInput[], searchCallCount: number): Promise<{ ok: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE evidence_scout_action
         SET state = 'completed', completed_at = now(), search_call_count = $3, leased_by = NULL, leased_until = NULL
         WHERE id = $1 AND state = 'searching' AND leased_by = $2 RETURNING id`,
        [actionId, workerId, searchCallCount],
      );
      if (updated.rowCount === 0) { await client.query("ROLLBACK"); return { ok: false }; }
      for (const c of candidates) {
        await client.query(
          `INSERT INTO evidence_scout_candidate
             (action_id, query, publisher, document_title, source_url, claim_summary, cited_text, fragment, publication_date, tier, verification_status, source_reliability)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [actionId, c.query, c.publisher, c.documentTitle, c.sourceUrl, c.claimSummary, c.citedText, c.fragment, c.publicationDate, c.tier, c.verificationStatus, c.sourceReliability],
        );
      }
      await client.query("COMMIT");
      return { ok: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async failAction(actionId: string, workerId: string, failureCode: EvidenceScoutFailureCode): Promise<{ ok: boolean }> {
    const result = await this.pool.query(
      `UPDATE evidence_scout_action SET state = 'failed', failure_code = $3, completed_at = now()
       , leased_by = NULL, leased_until = NULL
       WHERE id = $1 AND state = 'searching' AND leased_by = $2 RETURNING id`,
      [actionId, workerId, failureCode],
    );
    return { ok: (result.rowCount ?? 0) > 0 };
  }

  async markDispatchFailed(actionId: string): Promise<{ ok: boolean }> {
    const result = await this.pool.query(
      `UPDATE evidence_scout_action SET state = 'failed', failure_code = 'dispatch_failed', completed_at = now()
       WHERE id = $1 AND state = 'authorized' RETURNING id`,
      [actionId],
    );
    return { ok: (result.rowCount ?? 0) > 0 };
  }

  async getCandidate(candidateId: string): Promise<SourceCandidate | null> {
    const result = await this.pool.query<CandidateRow>(
      `SELECT c.id, c.action_id, a.case_id, c.query, c.publisher, c.document_title, c.source_url, c.claim_summary, c.cited_text, c.fragment,
              c.tier, c.state, c.verification_status, c.source_reliability, c.retrieved_at, c.decided_at, c.evidence_id, c.snapshot_id, c.iteration
       FROM evidence_scout_candidate c JOIN evidence_scout_action a ON a.id = c.action_id
       WHERE c.id = $1`,
      [candidateId],
    );
    const row = result.rows[0];
    return row ? mapCandidateRow(row) : null;
  }

  async decideCandidate(candidateId: string, decision: EvidenceScoutCandidateDecision): Promise<DecideCandidateResult> {
    const targetState = decision === "accept" ? "accepted" : "rejected";
    if (decision === "accept") {
      const candidate = await this.getCandidate(candidateId);
      if (!candidate) return { ok: false, code: "not_found" };
      if (!canAcceptCandidate(candidate)) return { ok: false, code: "source_located_cannot_be_accepted" };
    }
    const updated = await this.pool.query<CandidateRow>(
      `UPDATE evidence_scout_candidate c SET state = $2, decided_at = now()
       FROM evidence_scout_action a
       WHERE c.id = $1 AND c.action_id = a.id AND c.state = 'pending'
       RETURNING c.id, c.action_id, a.case_id, c.query, c.publisher, c.document_title, c.source_url, c.claim_summary, c.cited_text, c.fragment,
                 c.tier, c.state, c.verification_status, c.source_reliability, c.retrieved_at, c.decided_at, c.evidence_id, c.snapshot_id, c.iteration`,
      [candidateId, targetState],
    );
    if (updated.rows[0]) return { ok: true, candidate: mapCandidateRow(updated.rows[0]) };
    const existing = await this.getCandidate(candidateId);
    if (!existing) return { ok: false, code: "not_found" };
    if (existing.state === targetState) return { ok: true, candidate: existing }; // idempotent no-op
    return { ok: false, code: "already_decided_differently" };
  }
}

type EvidenceScoutStoreGlobals = typeof globalThis & {
  __priorLocalEvidenceScoutStore?: LocalEvidenceScoutCandidateStore;
  __priorCockroachEvidenceScoutStore?: CockroachDBEvidenceScoutCandidateStore;
};
const evidenceScoutStoreGlobals = globalThis as EvidenceScoutStoreGlobals;

/** Same DATABASE_URL-presence switch as getMemoryStore() in memory-store.ts. */
export function getEvidenceScoutCandidateStore(): EvidenceScoutCandidateStore {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return evidenceScoutStoreGlobals.__priorLocalEvidenceScoutStore ??= new LocalEvidenceScoutCandidateStore();
  if (!evidenceScoutStoreGlobals.__priorCockroachEvidenceScoutStore) {
    evidenceScoutStoreGlobals.__priorCockroachEvidenceScoutStore = new CockroachDBEvidenceScoutCandidateStore(new Pool(cockroachPoolOptions(databaseUrl)));
  }
  return evidenceScoutStoreGlobals.__priorCockroachEvidenceScoutStore;
}

/** Exposed for LocalMemoryStore.saveSnapshotWithEvidenceLinks's synchronous spend check when both stores are running in local/test mode. */
export function getLocalEvidenceScoutCandidateStoreIfActive(): LocalEvidenceScoutCandidateStore | null {
  const store = getEvidenceScoutCandidateStore();
  return store instanceof LocalEvidenceScoutCandidateStore ? store : null;
}
