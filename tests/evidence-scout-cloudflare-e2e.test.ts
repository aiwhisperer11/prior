import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateCaseCloudflareWaf } from "../lib/server/case-cloudflare-waf-assertions";
import { handleEvidenceScoutGetAction } from "../app/api/investigate/evidence-scout/actions/[actionId]/route";
import { handleEvidenceScoutCandidateDecision } from "../app/api/investigate/evidence-scout/candidates/[candidateId]/decision/route";
import { performEvidenceScoutSearch, type WebSearchClient, type WebSearchResponse } from "../lib/server/evidence-scout-search";
import { LocalEvidenceScoutCandidateStore, resolveAcceptedCandidatesForFollowUp } from "../lib/server/evidence-scout-store";
import { runInvestigationFlow } from "../lib/server/investigation-flow";
import { LocalMemoryStore } from "../lib/server/memory-store";
import { prepareInvestigationRequest } from "../lib/server/sherlock-engine";
import type { InvestigationRequest, SherlockInvestigation } from "../types/sherlock";

/**
 * Case positivo -- Cloudflare, el flujo E2E principal (per the architecture
 * review). Exercises the real GET/decision route handlers end to end; the
 * search step calls performEvidenceScoutSearch directly with an injected
 * fake WebSearchClient (never a real OpenAI call -- see
 * lib/server/evidence-scout-policy.ts's isEvidenceScoutSearchEnabled doc
 * comment for why this is the reliable mechanism, not a NODE_ENV check).
 */

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}
function fakeSearchClient(response: WebSearchResponse): WebSearchClient {
  return { responses: { create: async () => response } };
}
const fakeEmbedder = async (text: string) => ({ vector: Array.from({ length: 4 }, (_, i) => text.length + i), model: "fake-embedder" });

const CASE_ID = "case-cloudflare-waf-2019-e2e";
const cloudflareRequest = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");
const cloudflareExpected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");

test("Cloudflare local integration: missing evidence -> search -> candidate -> accept -> reinvestigate -> canonical E<n>, mechanism/scores unchanged", async () => {
  const store = new LocalEvidenceScoutCandidateStore();

  // 1. Baseline investigation, establishing the case.
  const preparedBaseline = prepareInvestigationRequest({ ...cloudflareRequest, case_id: CASE_ID });
  assert.equal(preparedBaseline.ok, true);
  if (!preparedBaseline.ok) return;
  const memoryStore = new LocalMemoryStore(fakeEmbedder, store);
  const baselineResult = await runInvestigationFlow(
    preparedBaseline.request,
    memoryStore,
    () => Promise.resolve({ ok: true, investigation: { ...cloudflareExpected, meta: { ...cloudflareExpected.meta, case_id: CASE_ID } }, rawResponses: [] }),
  );
  assert.equal(baselineResult.ok, true);
  if (!baselineResult.ok) return;
  const missingEvidenceTarget = baselineResult.investigation.missing_evidence[0]!;

  // 2. Authorize + run a search targeting that gap (a real Cloudflare postmortem URL/excerpt).
  const created = await store.createAction({
    caseId: CASE_ID,
    investigationId: null,
    missingEvidenceId: missingEvidenceTarget.id,
    queryIntent: missingEvidenceTarget.description,
    queries: ["Cloudflare July 2 2019 outage postmortem CPU exhaustion"],
    maxCandidates: 5,
    allowedDomains: null,
    idempotencyKey: "e2e-cloudflare-key-1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const postmortemText = 'Cloudflare\'s own postmortem states: "a CPU exhaustion issue that caused a global outage of our CDN and WAF functionality."';
  const quoteStart = postmortemText.indexOf('"a CPU exhaustion issue that caused a global outage of our CDN and WAF functionality."');
  const quoteEnd = quoteStart + '"a CPU exhaustion issue that caused a global outage of our CDN and WAF functionality."'.length;
  await performEvidenceScoutSearch(created.action.action_id, {
    store,
    client: fakeSearchClient({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: postmortemText,
          annotations: [{ type: "url_citation", url: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/", title: "Details of the Cloudflare outage on July 2, 2019", start_index: quoteStart, end_index: quoteEnd }],
        }],
      }],
    }),
  });

  // 3. Poll via the real GET route handler.
  const polled = await handleEvidenceScoutGetAction(new Request(`http://localhost/api/investigate/evidence-scout/actions/${created.action.action_id}`) as never, { params: Promise.resolve({ actionId: created.action.action_id }) }, store);
  assert.equal(polled.status, 200);
  const polledBody = await polled.json();
  assert.equal(polledBody.state, "completed");
  assert.equal(polledBody.candidates.length, 1);
  const candidate = polledBody.candidates[0];
  assert.equal(candidate.tier, "official_primary");
  assert.equal(candidate.verification_status, "verified_as_published");
  assert.ok(candidate.cited_text.includes("CPU exhaustion"));

  // 4. Accept via the real decision route handler.
  const decided = await handleEvidenceScoutCandidateDecision(
    new Request(`http://localhost/api/investigate/evidence-scout/candidates/${candidate.candidate_id}/decision`, { method: "POST", body: JSON.stringify({ decision: "accept" }) }) as never,
    { params: Promise.resolve({ candidateId: candidate.candidate_id }) },
    store,
  );
  assert.equal(decided.status, 200);
  const decidedBody = await decided.json();
  assert.equal(decidedBody.state, "accepted");
  assert.equal("provenance" in decidedBody, false, "the decision endpoint must never return provenance content, only id/state (point 7)");

  // 5. Resolve server-side (never trusting client-sent provenance) and reinvestigate.
  const resolution = await resolveAcceptedCandidatesForFollowUp(store, CASE_ID, [candidate.candidate_id]);
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  const preparedFollowUp = prepareInvestigationRequest({ previous_snapshot: baselineResult.investigation, new_evidence: [] }, resolution.resolved);
  assert.equal(preparedFollowUp.ok, true);
  if (!preparedFollowUp.ok) return;

  const nextEvidenceId = preparedFollowUp.request.evidence.at(-1)!.id;
  const followUpResponse: SherlockInvestigation = {
    ...cloudflareExpected,
    meta: { ...cloudflareExpected.meta, case_id: CASE_ID, iteration: 2 },
    case: { ...cloudflareExpected.case, evidence: preparedFollowUp.request.evidence },
  };
  const followUpResult = await runInvestigationFlow(
    preparedFollowUp.request,
    memoryStore,
    () => Promise.resolve({ ok: true, investigation: followUpResponse, rawResponses: [] }),
    preparedFollowUp.candidateLinks,
  );
  assert.equal(followUpResult.ok, true);
  if (!followUpResult.ok) return;

  // 6. Assertions: canonical E<n>, correct provenance, mechanism/scores unchanged.
  const newEvidence = followUpResult.investigation.case.evidence.find((e) => e.id === nextEvidenceId);
  assert.ok(newEvidence);
  assert.equal(newEvidence!.provenance?.source_url, "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/");
  assert.equal(newEvidence!.provenance?.verification_status, "verified_as_published");
  assert.equal(newEvidence!.provenance?.human_accepted_at, decidedBody.decided_at);

  assert.equal(followUpResult.investigation.root_cause_status, cloudflareExpected.root_cause_status);
  assert.equal(followUpResult.investigation.prime_suspect?.hypothesis_id, cloudflareExpected.prime_suspect?.hypothesis_id);
  const finalHypotheses = followUpResult.investigation.hypotheses;
  for (const h of cloudflareExpected.hypotheses) {
    const carried: (typeof finalHypotheses)[number] | undefined = finalHypotheses.find((x) => x.id === h.id);
    assert.equal(carried?.confidence, h.confidence, `${h.id} confidence must not drift from a mock reinvestigation response`);
  }

  // 7. The durable candidate -> evidence_id -> snapshot/iteration link (point 8).
  const finalCandidate = await store.getCandidate(candidate.candidate_id);
  assert.equal(finalCandidate?.evidence_id, nextEvidenceId);
  assert.equal(finalCandidate?.iteration, 2);

  // 8. Cloudflare's own assertion contract still holds (no reasoning regression).
  // Checked against the actual follow-up request (12 evidence items, including
  // the new Scout-sourced E12) -- the original 11-item baseline request would
  // itself flag E12 as "unknown", which is correct for that request, not a
  // finding about this follow-up.
  const assertions = evaluateCaseCloudflareWaf(preparedFollowUp.request, followUpResult.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});
