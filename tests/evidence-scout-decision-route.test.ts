import assert from "node:assert/strict";
import test from "node:test";

import { POST as decideCandidateRoute } from "../app/api/investigate/evidence-scout/candidates/[candidateId]/decision/route";
import { getEvidenceScoutCandidateStore } from "../lib/server/evidence-scout-store";

test("decision route rejects accept for source_located candidates", async () => {
  delete process.env.DATABASE_URL;
  const store = getEvidenceScoutCandidateStore();
  const created = await store.createAction({
    caseId: "case-source-located-route",
    investigationId: null,
    missingEvidenceId: null,
    queryIntent: "Find the source",
    queries: ["query"],
    maxCandidates: 1,
    allowedDomains: null,
    idempotencyKey: "route-source-located",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const claim = await store.claimAction(created.action.action_id);
  assert.equal(claim.claimed, true);
  await store.completeAction(created.action.action_id, claim.workerId, [{
    query: "query",
    publisher: "Publisher",
    documentTitle: "Document",
    sourceUrl: "https://example.com/source",
    claimSummary: "summary",
    citedText: null,
    fragment: null,
    publicationDate: null,
    tier: "official_primary",
    verificationStatus: "source_located",
    sourceReliability: "unknown",
  }], 1);

  const action = await store.getAction(created.action.action_id);
  const candidateId = action?.candidates[0]?.candidate_id;
  assert.ok(candidateId);

  const response = await decideCandidateRoute(
    new Request(`http://localhost/api/investigate/evidence-scout/candidates/${candidateId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    }) as never,
    { params: Promise.resolve({ candidateId: candidateId! }) },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: `candidate ${candidateId} is source_located and cannot be accepted as evidence` });
  const candidate = await store.getCandidate(candidateId!);
  assert.equal(candidate?.state, "pending");
});
