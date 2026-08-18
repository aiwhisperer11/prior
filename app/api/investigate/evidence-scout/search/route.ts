import { NextRequest, NextResponse } from "next/server";

import { getEvidenceScoutExecutor, type EvidenceScoutExecutor } from "@/lib/server/evidence-scout-executor";
import { isEvidenceScoutSearchEnabled, validateSearchRequestShape } from "@/lib/server/evidence-scout-policy";
import { getEvidenceScoutCandidateStore, type CreateActionInput, type EvidenceScoutCandidateStore } from "@/lib/server/evidence-scout-store";

/**
 * POST /api/investigate/evidence-scout/search -- creates and dispatches a
 * search action, then returns 202 immediately. The client polls
 * GET /api/investigate/evidence-scout/actions/:actionId for the result.
 *
 * The route always awaits executor.invoke() (an explicit architecture
 * requirement): for the Local executor this runs the whole search
 * synchronously in-process (correct for dev/test, see
 * lib/server/evidence-scout-executor.ts); for the SQS executor it only
 * awaits the SendMessageCommand acknowledgment (fast -- the Lambda-driven
 * search itself happens asynchronously afterward), so the 202 contract
 * still holds in production.
 */
export interface EvidenceScoutSearchRouteDependencies {
  executorFactory?: (store: EvidenceScoutCandidateStore) => EvidenceScoutExecutor;
  store?: EvidenceScoutCandidateStore;
}

export async function handleEvidenceScoutSearchPost(req: NextRequest, deps: EvidenceScoutSearchRouteDependencies = {}) {
  if (!isEvidenceScoutSearchEnabled()) {
    return NextResponse.json({ error: "Evidence Scout search is disabled. Set ENABLE_EVIDENCE_SCOUT_SEARCH=1 to enable it." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "request body must be a JSON object" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;

  const validation = validateSearchRequestShape({
    queries: record.queries,
    maxCandidates: record.max_candidates,
    queryIntent: record.query_intent,
    caseId: record.case_id,
    authorized: record.authorized,
  });
  if (!validation.ok) return NextResponse.json({ error: validation.message }, { status: 400 });

  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (!idempotencyKey || !idempotencyKey.trim()) {
    return NextResponse.json({ error: "Idempotency-Key header is required" }, { status: 400 });
  }

  const input: CreateActionInput = {
    caseId: record.case_id as string,
    investigationId: typeof record.investigation_id === "string" ? record.investigation_id : null,
    missingEvidenceId: typeof record.missing_evidence_id === "string" ? record.missing_evidence_id : null,
    queryIntent: record.query_intent as string,
    queries: record.queries as string[],
    maxCandidates: record.max_candidates as number,
    allowedDomains: Array.isArray(record.allowed_domains) ? (record.allowed_domains as string[]) : null,
    idempotencyKey,
  };

  const store = deps.store ?? getEvidenceScoutCandidateStore();
  let created = await store.createAction(input);
  // Retryable vs terminal, explicit: a transient CockroachDB serialization
  // conflict on the daily-budget check (point: "daily budget en
  // transacción serializable") gets exactly one retry here, never a silent
  // loop; daily_budget_exceeded / case_not_allowlisted / invalid_input are
  // terminal and never retried.
  if (!created.ok && created.code === "retryable") created = await store.createAction(input);

  if (!created.ok) {
    const status = created.code === "daily_budget_exceeded" || created.code === "case_not_allowlisted" ? 429 : created.code === "retryable" ? 503 : 400;
    return NextResponse.json({ error: created.message }, { status });
  }

  if (created.shouldDispatch) {
    const executor = deps.executorFactory?.(store) ?? getEvidenceScoutExecutor({ store });
    try {
      await executor.invoke(created.action.action_id);
    } catch {
      // This remains a client-recoverable limitation, not a solved outbox:
      // if the process crashes after the DB insert but before this catch
      // runs, the row can remain `authorized` until the client retries with
      // the same Idempotency-Key. We document that explicitly in
      // docs/evidence-scout.md instead of claiming automatic recovery.
      await store.markDispatchFailed(created.action.action_id);
      return NextResponse.json({ error: "Failed to dispatch the search action; it has been marked dispatch_failed and may be retried with the same Idempotency-Key." }, { status: 502 });
    }
  }

  return NextResponse.json({ action_id: created.action.action_id, state: created.action.state }, { status: 202 });
}

export async function POST(req: NextRequest) {
  return handleEvidenceScoutSearchPost(req);
}
