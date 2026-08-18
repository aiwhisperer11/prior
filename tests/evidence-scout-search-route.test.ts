import assert from "node:assert/strict";
import test from "node:test";

import { handleEvidenceScoutSearchPost } from "../app/api/investigate/evidence-scout/search/route";
import { LocalEvidenceScoutCandidateStore, type CreateActionInput, type EvidenceScoutCandidateStore } from "../lib/server/evidence-scout-store";

function baseBody() {
  return {
    case_id: "case-cloudflare-route",
    query_intent: "Find the official Cloudflare postmortem.",
    queries: ["Cloudflare outage postmortem"],
    max_candidates: 1,
    authorized: true,
  };
}

function searchRequestBody(overrides: Partial<ReturnType<typeof baseBody>> = {}) {
  return {
    ...baseBody(),
    ...overrides,
  };
}

function request(body: Record<string, unknown>, idempotencyKey?: string): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return new Request("http://localhost/api/investigate/evidence-scout/search", { method: "POST", headers, body: JSON.stringify(body) });
}

type TestGlobals = typeof globalThis & {
  __priorLocalEvidenceScoutStore?: LocalEvidenceScoutCandidateStore;
  __priorCockroachEvidenceScoutStore?: unknown;
};

function resetEvidenceScoutGlobals(): void {
  delete process.env.DATABASE_URL;
  const globals = globalThis as TestGlobals;
  delete globals.__priorLocalEvidenceScoutStore;
  delete globals.__priorCockroachEvidenceScoutStore;
}

async function withSearchEnabled<T>(run: () => Promise<T>): Promise<T> {
  const original = process.env.ENABLE_EVIDENCE_SCOUT_SEARCH;
  process.env.ENABLE_EVIDENCE_SCOUT_SEARCH = "1";
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.ENABLE_EVIDENCE_SCOUT_SEARCH;
    else process.env.ENABLE_EVIDENCE_SCOUT_SEARCH = original;
  }
}

test.beforeEach(resetEvidenceScoutGlobals);
test.afterEach(resetEvidenceScoutGlobals);

async function completeImmediately(store: EvidenceScoutCandidateStore, actionId: string): Promise<void> {
  const claim = await store.claimAction(actionId);
  assert.equal(claim.claimed, true);
  await store.completeAction(actionId, claim.workerId, [], 1);
}

test("createAction.shouldDispatch matches the action-state table", async () => {
  const store = new LocalEvidenceScoutCandidateStore();

  const authorized = await store.createAction({
    caseId: "case-dispatch-authorized",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the official postmortem.",
    queries: ["Cloudflare postmortem"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: "dispatch-table-authorized",
  });
  assert.equal(authorized.ok, true);
  if (!authorized.ok) return;
  assert.equal(authorized.shouldDispatch, true);

  await store.markDispatchFailed(authorized.action.action_id);
  const revived = await store.createAction({
    caseId: "case-dispatch-authorized",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the official postmortem.",
    queries: ["Cloudflare postmortem"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: "dispatch-table-authorized",
  });
  assert.equal(revived.ok, true);
  if (!revived.ok) return;
  assert.equal(revived.action.state, "authorized");
  assert.equal(revived.shouldDispatch, true);

  const searchingStore = new LocalEvidenceScoutCandidateStore();
  const searching = await searchingStore.createAction({
    caseId: "case-dispatch-searching",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the official postmortem.",
    queries: ["Cloudflare postmortem"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: "dispatch-table-searching",
  });
  assert.equal(searching.ok, true);
  if (!searching.ok) return;
  const searchingClaim = await searchingStore.claimAction(searching.action.action_id);
  assert.equal(searchingClaim.claimed, true);
  const searchingReplay = await searchingStore.createAction({
    caseId: "case-dispatch-searching",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the official postmortem.",
    queries: ["Cloudflare postmortem"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: "dispatch-table-searching",
  });
  assert.equal(searchingReplay.ok, true);
  if (!searchingReplay.ok) return;
  assert.equal(searchingReplay.action.state, "searching");
  assert.equal(searchingReplay.shouldDispatch, false);

  const completedStore = new LocalEvidenceScoutCandidateStore();
  const completed = await completedStore.createAction({
    caseId: "case-dispatch-completed",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the official postmortem.",
    queries: ["Cloudflare postmortem"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: "dispatch-table-completed",
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  await completeImmediately(completedStore, completed.action.action_id);
  const completedReplay = await completedStore.createAction({
    caseId: "case-dispatch-completed",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the official postmortem.",
    queries: ["Cloudflare postmortem"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: "dispatch-table-completed",
  });
  assert.equal(completedReplay.ok, true);
  if (!completedReplay.ok) return;
  assert.equal(completedReplay.action.state, "completed");
  assert.equal(completedReplay.shouldDispatch, false);
});

test("search route requires Idempotency-Key", async () => {
  const response = await withSearchEnabled(() => handleEvidenceScoutSearchPost(request(searchRequestBody()) as never, { store: new LocalEvidenceScoutCandidateStore() }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Idempotency-Key header is required" });
});

test("search route awaits executor.invoke before replying", async () => {
  await withSearchEnabled(async () => {
    const store = new LocalEvidenceScoutCandidateStore();
    let invokeCalls = 0;
    let resolveInvoke: (() => void) | undefined;
    const invokeGate = new Promise<void>((resolve) => { resolveInvoke = resolve; });
    let markInvoked: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });

    let settled = false;
    const responsePromise = handleEvidenceScoutSearchPost(
      request(searchRequestBody(), "await-key") as never,
      {
        store,
        executorFactory: () => ({
          invoke: async () => {
            invokeCalls += 1;
            markInvoked?.();
            await invokeGate;
          },
        }),
      },
    );
    responsePromise.then(() => { settled = true; });

    await invoked;
    assert.equal(invokeCalls, 1);
    assert.equal(settled, false);

    resolveInvoke?.();
    const response = await responsePromise;
    assert.equal(response.status, 202);
  });
});

test("dispatch retry with the same Idempotency-Key revives dispatch_failed without spending budget twice", async () => {
  await withSearchEnabled(async () => {
    const store = new LocalEvidenceScoutCandidateStore(1);
    let invokeCalls = 0;

    const first = await handleEvidenceScoutSearchPost(
      request(searchRequestBody(), "dispatch-retry-key") as never,
      {
        store,
        executorFactory: () => ({
          invoke: async () => {
            invokeCalls += 1;
            throw new Error("synthetic first-send failure");
          },
        }),
      },
    );
    assert.equal(first.status, 502);

    const second = await handleEvidenceScoutSearchPost(
      request(searchRequestBody(), "dispatch-retry-key") as never,
      {
        store,
        executorFactory: () => ({
          invoke: async (actionId) => {
            invokeCalls += 1;
            await completeImmediately(store, actionId);
          },
        }),
      },
    );
    assert.equal(second.status, 202);
    const secondBody = await second.json();
    assert.equal(typeof secondBody.action_id, "string");
    assert.equal(invokeCalls, 2);

    const action = await store.getAction(secondBody.action_id);
    assert.equal(action?.state, "completed");
    assert.equal(action?.failure_code, null);

    const third = await handleEvidenceScoutSearchPost(
      request(searchRequestBody(), "dispatch-retry-key") as never,
      {
        store,
        executorFactory: () => ({
          invoke: async () => {
            invokeCalls += 1;
          },
        }),
      },
    );
    assert.equal(third.status, 202);
    assert.equal(invokeCalls, 2, "a completed action must not be dispatched again");
  });
});

test("an idempotent replay of a searching action does not send again", async () => {
  await withSearchEnabled(async () => {
    const store = new LocalEvidenceScoutCandidateStore();
    const input: CreateActionInput = {
      caseId: "case-searching-replay",
      investigationId: null,
      missingEvidenceId: null,
      queryIntent: "Find the official postmortem.",
      queries: ["Cloudflare postmortem"],
      maxCandidates: 1,
      allowedDomains: null,
      idempotencyKey: "searching-key",
    };
    const created = await store.createAction(input);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const claim = await store.claimAction(created.action.action_id);
    assert.equal(claim.claimed, true);
    const replay = await store.createAction(input);
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.action.state, "searching");
    assert.equal(replay.shouldDispatch, false);

    let invokeCalls = 0;
    const response = await handleEvidenceScoutSearchPost(
      request(searchRequestBody({
        case_id: input.caseId,
        query_intent: input.queryIntent,
        queries: input.queries,
        max_candidates: input.maxCandidates,
      }), "searching-key") as never,
      {
        store,
        executorFactory: () => ({
          invoke: async () => {
            invokeCalls += 1;
          },
        }),
      },
    );

    assert.equal(response.status, 202);
    assert.equal(invokeCalls, 0);
    assert.deepEqual(await response.json(), { action_id: created.action.action_id, state: "searching" });
  });
});
