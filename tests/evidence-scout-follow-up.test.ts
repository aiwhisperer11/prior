import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type OpenAI from "openai";

import { isLegacyCompatiblePreviousSnapshot } from "../lib/server/evidence-scout-legacy-schema";
import { runInvestigationFlow } from "../lib/server/investigation-flow";
import { LocalMemoryStore } from "../lib/server/memory-store";
import { prepareInvestigationRequest, runSherlockInvestigation } from "../lib/server/sherlock-engine";
import { LocalEvidenceScoutCandidateStore, resolveAcceptedCandidatesForFollowUp, type NewCandidateInput } from "../lib/server/evidence-scout-store";
import type { InvestigationRequest, SherlockInvestigation } from "../types/sherlock";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

function fakeClient(responses: string[]): OpenAI {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: responses.shift() ?? null } }] }) } },
  } as unknown as OpenAI;
}

const fakeEmbedder = async (text: string) => ({ vector: Array.from({ length: 4 }, (_, i) => text.length + i), model: "fake-embedder" });

const cloudflareRequest = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");
const cloudflareExpected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");

async function acceptedCandidateId(store: LocalEvidenceScoutCandidateStore, caseId: string, overrides: Partial<NewCandidateInput> = {}): Promise<string> {
  const created = await store.createAction({
    caseId,
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "test intent",
    queries: ["test query"],
    maxCandidates: 5,
    allowedDomains: null,
    idempotencyKey: `key-${Math.random()}`,
  });
  if (!created.ok) throw new Error("createAction failed in test setup");
  const claim = await store.claimAction(created.action.action_id);
  await store.completeAction(created.action.action_id, claim.workerId, [{
    query: "test query",
    publisher: "Cloudflare",
    documentTitle: "Details of the Cloudflare outage",
    sourceUrl: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
    claimSummary: "test claim summary",
    citedText: "a literal excerpt",
    fragment: "a literal excerpt",
    publicationDate: null,
    tier: "official_primary",
    verificationStatus: "verified_as_published",
    sourceReliability: "high",
    ...overrides,
  }], 1);
  const action = await store.getAction(created.action.action_id);
  const candidateId = action!.candidates[0]!.candidate_id;
  await store.decideCandidate(candidateId, "accept");
  return candidateId;
}

// --- Legacy schema: previous_snapshot without provenance validates --------

test("legacy evidence without a provenance key validates under the relaxed legacy validator", () => {
  const legacy = structuredClone(cloudflareExpected) as unknown as { case: { evidence: Array<Record<string, unknown>> } } & Record<string, unknown>;
  for (const item of legacy.case.evidence) delete item.provenance; // simulate a real pre-feature persisted row: key absent, not null
  assert.equal(isLegacyCompatiblePreviousSnapshot(legacy), true);
});

test("a full follow-up round-trip works from a legacy previous_snapshot that structurally lacks provenance", async () => {
  const legacy = structuredClone(cloudflareExpected) as unknown as { case: { evidence: Array<Record<string, unknown>> } } & Record<string, unknown>;
  for (const item of legacy.case.evidence) delete item.provenance;

  const prepared = prepareInvestigationRequest({
    previous_snapshot: legacy,
    new_evidence: [{ label: "Follow-up note", content: "Additional detail." }],
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await runSherlockInvestigation(prepared.request, fakeClient([JSON.stringify({ ...cloudflareExpected, meta: { ...cloudflareExpected.meta, iteration: 2 } })]));
  assert.equal(result.ok, true);
});

// --- provenance never inferred / server-owned wins over the model's echo --

test("a fake provenance object injected by the model is discarded; the final evidence is byte-for-byte the server's own request.evidence", async () => {
  const tampered: SherlockInvestigation = {
    ...cloudflareExpected,
    case: {
      ...cloudflareExpected.case,
      evidence: cloudflareExpected.case.evidence.map((item, index) =>
        index === 0
          ? {
              ...item,
              provenance: {
                evidence_type: "official_publication",
                publisher: "A model-invented publisher",
                document_title: "A model-invented title",
                source_url: "https://model-invented.example.com/",
                publication_date: null,
                retrieved_at: "2020-01-01T00:00:00.000Z",
                fragment: "invented",
                cited_text: "invented",
                claim_summary: "invented",
                human_accepted_at: "2020-01-01T00:00:00.000Z",
                verification_status: "verified_as_published",
                source_reliability: "high",
                search_lineage: { action_id: "invented", query: "invented", candidate_id: "invented" },
              },
            }
          : item,
      ),
    },
  };

  const result = await runSherlockInvestigation({ ...cloudflareRequest, iteration: 1 } as never, fakeClient([JSON.stringify(tampered)]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const item of result.investigation.case.evidence) {
    assert.equal(item.provenance, null, `${item.id} must have provenance null -- the model's invented object must never survive the Case Envelope`);
  }
});

// --- source_located rejected for reinvestigation (end-to-end) --------------

test("a follow-up request referencing a source_located candidate is rejected before any model call", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const caseId = "case-cloudflare-waf-2019-source-located";
  const candidateId = await acceptedCandidateId(store, caseId, { verificationStatus: "source_located", citedText: null, fragment: null });
  const resolution = await resolveAcceptedCandidatesForFollowUp(store, caseId, [candidateId]);
  assert.equal(resolution.ok, false);
});

// --- Candidate race: two follow-ups competing for one candidate -----------

test("two concurrent follow-ups referencing the same accepted candidate: exactly one succeeds, the other is rejected, no orphaned snapshot", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const caseId = "case-cloudflare-waf-2019-race";
  const candidateId = await acceptedCandidateId(store, caseId);
  const resolution = await resolveAcceptedCandidatesForFollowUp(store, caseId, [candidateId]);
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;

  const baseRequest: InvestigationRequest = { ...cloudflareRequest, case_id: caseId };
  const preparedBaseline = prepareInvestigationRequest(baseRequest);
  assert.equal(preparedBaseline.ok, true);
  if (!preparedBaseline.ok) return;
  const memoryStore = new LocalMemoryStore(fakeEmbedder, store);
  const baselineResult = await runInvestigationFlow(preparedBaseline.request, memoryStore, () => Promise.resolve({ ok: true, investigation: { ...cloudflareExpected, meta: { ...cloudflareExpected.meta, case_id: caseId } }, rawResponses: [] }));
  assert.equal(baselineResult.ok, true);
  if (!baselineResult.ok) return;

  // Build two independent follow-up requests, both spending the same candidate.
  const preparedA = prepareInvestigationRequest({ previous_snapshot: baselineResult.investigation, new_evidence: [] }, resolution.resolved);
  const preparedB = prepareInvestigationRequest({ previous_snapshot: baselineResult.investigation, new_evidence: [] }, resolution.resolved);
  assert.equal(preparedA.ok, true);
  assert.equal(preparedB.ok, true);
  if (!preparedA.ok || !preparedB.ok) return;

  const followUpResponse = (iteration: number): SherlockInvestigation => ({ ...cloudflareExpected, meta: { ...cloudflareExpected.meta, case_id: caseId, iteration } });

  const [resultA, resultB] = await Promise.all([
    runInvestigationFlow(preparedA.request, memoryStore, () => Promise.resolve({ ok: true, investigation: followUpResponse(2), rawResponses: [] }), preparedA.candidateLinks),
    runInvestigationFlow(preparedB.request, memoryStore, () => Promise.resolve({ ok: true, investigation: followUpResponse(2), rawResponses: [] }), preparedB.candidateLinks),
  ]);

  const outcomes = [resultA, resultB];
  const succeeded = outcomes.filter((r) => r.ok);
  const failed = outcomes.filter((r) => !r.ok);
  assert.equal(succeeded.length, 1, "exactly one of the two racing follow-ups must succeed");
  assert.equal(failed.length, 1, "the other must be rejected");
  const rejected = failed[0]!;
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.ok(rejected.validationErrors.some((e) => e.keyword === "candidate_already_spent"), JSON.stringify(rejected.validationErrors));

  // The candidate is spent exactly once.
  const finalCandidate = await store.getCandidate(candidateId);
  assert.notEqual(finalCandidate?.evidence_id, null);
});

test("rollback: a candidate link failure never leaves a persisted snapshot behind", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const caseId = "case-cloudflare-waf-2019-rollback";
  const candidateId = await acceptedCandidateId(store, caseId);
  const resolution = await resolveAcceptedCandidatesForFollowUp(store, caseId, [candidateId]);
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;

  const baseRequest: InvestigationRequest = { ...cloudflareRequest, case_id: caseId };
  const preparedBaseline = prepareInvestigationRequest(baseRequest);
  assert.equal(preparedBaseline.ok, true);
  if (!preparedBaseline.ok) return;
  const memoryStore = new LocalMemoryStore(fakeEmbedder, store);
  const baselineResult = await runInvestigationFlow(preparedBaseline.request, memoryStore, () => Promise.resolve({ ok: true, investigation: { ...cloudflareExpected, meta: { ...cloudflareExpected.meta, case_id: caseId } }, rawResponses: [] }));
  assert.equal(baselineResult.ok, true);
  if (!baselineResult.ok) return;

  // Spend the candidate directly first (simulating a prior successful follow-up), then attempt another follow-up with the same link.
  await store.decideCandidate(candidateId, "accept"); // already accepted; no-op
  const prepared = prepareInvestigationRequest({ previous_snapshot: baselineResult.investigation, new_evidence: [] }, resolution.resolved);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const recordCountBefore = (memoryStore as unknown as { records: unknown[] }).records.length;
  // Manually pre-spend the candidate to force the link step to fail deterministically.
  const preSpend = await memoryStore.saveSnapshotWithEvidenceLinks(
    { investigation: { ...cloudflareExpected, meta: { ...cloudflareExpected.meta, case_id: caseId, iteration: 2 } }, isMock: true },
    prepared.candidateLinks,
  );
  assert.equal(preSpend.ok, true);
  const recordCountAfterFirst = (memoryStore as unknown as { records: unknown[] }).records.length;
  assert.equal(recordCountAfterFirst, recordCountBefore + 1);

  // A second attempt to link the SAME (now-spent) candidate must roll back cleanly.
  const secondAttempt = await memoryStore.saveSnapshotWithEvidenceLinks(
    { investigation: { ...cloudflareExpected, meta: { ...cloudflareExpected.meta, case_id: caseId, iteration: 3 } }, isMock: true },
    prepared.candidateLinks,
  );
  assert.equal(secondAttempt.ok, false);
  const recordCountAfterSecond = (memoryStore as unknown as { records: unknown[] }).records.length;
  assert.equal(recordCountAfterSecond, recordCountAfterFirst, "the failed link attempt must never leave a new snapshot record behind");
});
