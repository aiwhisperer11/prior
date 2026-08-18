import assert from "node:assert/strict";
import test from "node:test";

import { LocalEvidenceScoutCandidateStore, MAX_ATTEMPTS, resolveAcceptedCandidatesForFollowUp, type CreateActionInput, type EvidenceScoutCandidateStore, type NewCandidateInput } from "../lib/server/evidence-scout-store";
import type { SourceCandidate } from "../types/evidence-scout";

function baseInput(overrides: Partial<CreateActionInput> = {}): CreateActionInput {
  return {
    caseId: "case-cloudflare-waf-2019",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the official Cloudflare postmortem for the 2019-07-02 outage.",
    queries: ["Cloudflare July 2 2019 outage postmortem"],
    maxCandidates: 5,
    allowedDomains: null,
    idempotencyKey: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<NewCandidateInput> = {}): NewCandidateInput {
  return {
    query: "Cloudflare July 2 2019 outage postmortem",
    publisher: "Cloudflare",
    documentTitle: "Details of the Cloudflare outage on July 2, 2019",
    sourceUrl: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
    claimSummary: "Cloudflare's own postmortem describes a WAF rule causing CPU exhaustion.",
    citedText: "a CPU exhaustion issue that caused a global outage",
    fragment: "a CPU exhaustion issue that caused a global outage",
    publicationDate: null,
    tier: "official_primary",
    verificationStatus: "verified_as_published",
    sourceReliability: "high",
    ...overrides,
  };
}

// --- Idempotency-Key -------------------------------------------------------

test("createAction is idempotent by (case_id, idempotency_key): a retried request returns the same action, never a duplicate", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const first = await store.createAction(baseInput({ idempotencyKey: "key-1" }));
  const second = await store.createAction(baseInput({ idempotencyKey: "key-1" }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.action.action_id, second.action.action_id);
});

// --- Daily budget ------------------------------------------------------------

test("daily budget exhausted: the (n+1)th action of the day is rejected, no row created", async () => {
  const store = new LocalEvidenceScoutCandidateStore(1);
  const first = await store.createAction(baseInput({ idempotencyKey: "a" }));
  assert.equal(first.ok, true);
  const second = await store.createAction(baseInput({ idempotencyKey: "b" }));
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.code, "daily_budget_exceeded");
});

// --- Claim / lease / SQS duplicate delivery --------------------------------

test("SQS duplicate delivery: two concurrent claim attempts on the same authorized action -- only one succeeds", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const [first, second] = await Promise.all([store.claimAction(created.action.action_id), store.claimAction(created.action.action_id)]);
  const claimedCount = [first, second].filter((r) => r.claimed).length;
  assert.equal(claimedCount, 1, "exactly one of two concurrent claims must succeed");

  const action = await store.getAction(created.action.action_id);
  assert.equal(action?.attempt_count, 1, "attempt_count increments exactly once, not twice, across both claim attempts");
});

test("crash + lease expiry + redelivery: an abandoned claim becomes reclaimable, and a second attempt can complete it", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const actionId = created.action.action_id;

  const firstClaim = await store.claimAction(actionId); // simulates the first (crashed) Lambda invocation
  assert.equal(firstClaim.claimed, true);
  assert.equal((await store.getAction(actionId))?.attempt_count, 1);

  // The "crashed" worker never calls completeAction/failAction. Simulate the
  // lease expiring by backdating it directly (equivalent to time passing
  // past leased_until without touching any other state).
  const internal = store as unknown as { actions: Map<string, { leasedUntil: string | null }> };
  const record = internal.actions.get(actionId)!;
  record.leasedUntil = new Date(Date.now() - 1000).toISOString();

  const secondClaim = await store.claimAction(actionId); // simulates SQS redelivering after VisibilityTimeout
  assert.equal(secondClaim.claimed, true, "an expired lease must be reclaimable by a new invocation");
  assert.equal((await store.getAction(actionId))?.attempt_count, 2);

  const completed = await store.completeAction(actionId, secondClaim.workerId, [candidate()], 1);
  assert.equal(completed.ok, true);
  const finalAction = await store.getAction(actionId);
  assert.equal(finalAction?.state, "completed");
  assert.equal(finalAction?.candidates.length, 1);
});

test("the first (crashed) worker's late completeAction/failAction is rejected once its lease has been reassigned", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const actionId = created.action.action_id;

  const firstClaim = await store.claimAction(actionId);
  const internal = store as unknown as { actions: Map<string, { leasedUntil: string | null }> };
  internal.actions.get(actionId)!.leasedUntil = new Date(Date.now() - 1000).toISOString();
  const secondClaim = await store.claimAction(actionId);
  assert.equal(secondClaim.claimed, true);

  // The original (now-superseded) worker tries to finalize late -- it must
  // be rejected, never allowed to clobber the newer attempt's result.
  const lateComplete = await store.completeAction(actionId, firstClaim.workerId, [candidate()], 1);
  assert.equal(lateComplete.ok, false);
});

// --- DLQ / attempt exhaustion (DB-level ceiling; SQS-level maxReceiveCount is exercised only by the live test) ---

test("attempt exhaustion: after MAX_ATTEMPTS claim+crash cycles, no further claim succeeds, and a poll lazily reaps the action to failed", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const actionId = created.action.action_id;
  const internal = store as unknown as { actions: Map<string, { leasedUntil: string | null; attempt_count: number }> };

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const claim = await store.claimAction(actionId);
    assert.equal(claim.claimed, true, `attempt ${i + 1} should succeed`);
    internal.actions.get(actionId)!.leasedUntil = new Date(Date.now() - 1000).toISOString(); // simulate crash + expiry
  }
  assert.equal(internal.actions.get(actionId)!.attempt_count, MAX_ATTEMPTS);

  const overLimitClaim = await store.claimAction(actionId);
  assert.equal(overLimitClaim.claimed, false, "a claim beyond MAX_ATTEMPTS must never succeed, even with an expired lease");

  // Lazy reap on read: getAction observes the expired, attempt-exhausted lease and repairs it.
  const polled = await store.getAction(actionId);
  assert.equal(polled?.state, "failed");
  assert.equal(polled?.failure_code, "max_attempts_exceeded");
});

// --- Candidate decision: idempotent, terminal, never a silent flip --------

test("decideCandidate is idempotent: repeating the same decision returns the same result, not an error", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const claim = await store.claimAction(created.action.action_id);
  await store.completeAction(created.action.action_id, claim.workerId, [candidate()], 1);
  const action = await store.getAction(created.action.action_id);
  const candidateId = action!.candidates[0]!.candidate_id;

  const first = await store.decideCandidate(candidateId, "accept");
  const second = await store.decideCandidate(candidateId, "accept");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

test("decideCandidate rejects flipping an already-decided candidate to the opposite decision", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const claim = await store.claimAction(created.action.action_id);
  await store.completeAction(created.action.action_id, claim.workerId, [candidate()], 1);
  const action = await store.getAction(created.action.action_id);
  const candidateId = action!.candidates[0]!.candidate_id;

  await store.decideCandidate(candidateId, "accept");
  const flip = await store.decideCandidate(candidateId, "reject");
  assert.equal(flip.ok, false);
  if (flip.ok) return;
  assert.equal(flip.code, "already_decided_differently");
});

test("decideCandidate rejects accepting a source_located candidate in the local store", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const claim = await store.claimAction(created.action.action_id);
  await store.completeAction(created.action.action_id, claim.workerId, [candidate({ verificationStatus: "source_located", citedText: null, fragment: null })], 1);
  const action = await store.getAction(created.action.action_id);
  const candidateId = action!.candidates[0]!.candidate_id;

  const decision = await store.decideCandidate(candidateId, "accept");
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.code, "source_located_cannot_be_accepted");
});

// --- source_located rejected for reinvestigation ----------------------------

test("resolveAcceptedCandidatesForFollowUp rejects a legacy/corrupt accepted+source_located candidate (point 8)", async () => {
  const corruptCandidate: SourceCandidate = {
    candidate_id: "legacy-source-located",
    action_id: "action-1",
    case_id: "case-cloudflare-waf-2019",
    query: "Cloudflare July 2 2019 outage postmortem",
    publisher: "Cloudflare",
    document_title: "Details of the Cloudflare outage on July 2, 2019",
    source_url: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
    claim_summary: "Only the source was located; no quotable support exists.",
    cited_text: null,
    fragment: null,
    tier: "official_primary",
    verification_status: "source_located",
    source_reliability: "high",
    retrieved_at: "2026-08-16T00:00:00.000Z",
    state: "accepted",
    decided_at: "2026-08-16T00:00:00.000Z",
    evidence_id: null,
    snapshot_id: null,
    iteration: null,
  };
  const store: EvidenceScoutCandidateStore = {
    createAction: async () => { throw new Error("not used"); },
    getAction: async () => { throw new Error("not used"); },
    claimAction: async () => { throw new Error("not used"); },
    completeAction: async () => { throw new Error("not used"); },
    failAction: async () => { throw new Error("not used"); },
    markDispatchFailed: async () => { throw new Error("not used"); },
    getCandidate: async (candidateId) => candidateId === corruptCandidate.candidate_id ? corruptCandidate : null,
    decideCandidate: async () => { throw new Error("not used"); },
  };

  const resolution = await resolveAcceptedCandidatesForFollowUp(store, "case-cloudflare-waf-2019", [corruptCandidate.candidate_id]);
  assert.equal(resolution.ok, false);
  if (resolution.ok) return;
  assert.match(resolution.message, /source_located/);
});

test("resolveAcceptedCandidatesForFollowUp rejects a candidate not belonging to the given case", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput({ caseId: "case-a" }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const claim = await store.claimAction(created.action.action_id);
  await store.completeAction(created.action.action_id, claim.workerId, [candidate()], 1);
  const action = await store.getAction(created.action.action_id);
  const candidateId = action!.candidates[0]!.candidate_id;
  await store.decideCandidate(candidateId, "accept");

  const resolution = await resolveAcceptedCandidatesForFollowUp(store, "case-b", [candidateId]);
  assert.equal(resolution.ok, false);
});

test("resolveAcceptedCandidatesForFollowUp rejects exact duplicate candidate ids within one request", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const claim = await store.claimAction(created.action.action_id);
  await store.completeAction(created.action.action_id, claim.workerId, [candidate()], 1);
  const action = await store.getAction(created.action.action_id);
  const candidateId = action!.candidates[0]!.candidate_id;
  await store.decideCandidate(candidateId, "accept");

  const resolution = await resolveAcceptedCandidatesForFollowUp(store, "case-cloudflare-waf-2019", [candidateId, candidateId]);
  assert.equal(resolution.ok, false);
  if (resolution.ok) return;
  assert.match(resolution.message, /duplicate/);
});

test("resolveAcceptedCandidatesForFollowUp resolves a valid, eligible, accepted candidate into full provenance", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const claim = await store.claimAction(created.action.action_id);
  await store.completeAction(created.action.action_id, claim.workerId, [candidate()], 1);
  const action = await store.getAction(created.action.action_id);
  const candidateId = action!.candidates[0]!.candidate_id;
  await store.decideCandidate(candidateId, "accept");

  const resolution = await resolveAcceptedCandidatesForFollowUp(store, "case-cloudflare-waf-2019", [candidateId]);
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.equal(resolution.resolved.length, 1);
  const [resolved] = resolution.resolved;
  assert.equal(resolved!.provenance.source_url, "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/");
  assert.equal(resolved!.provenance.verification_status, "verified_as_published");
  assert.equal(resolved!.provenance.evidence_type, "official_publication");
  assert.equal(resolved!.provenance.search_lineage.candidate_id, candidateId);
});
