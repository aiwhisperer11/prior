import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateCaseGoogleSecOps } from "../lib/server/case-google-secops-assertions";
import { performEvidenceScoutSearch, type WebSearchClient, type WebSearchResponse } from "../lib/server/evidence-scout-search";
import { LocalEvidenceScoutCandidateStore } from "../lib/server/evidence-scout-store";
import { runInvestigationFlow } from "../lib/server/investigation-flow";
import { LocalMemoryStore } from "../lib/server/memory-store";
import { prepareInvestigationRequest } from "../lib/server/sherlock-engine";
import type { InvestigationRequest, SherlockInvestigation } from "../types/sherlock";

/**
 * Caso negativo -- Google: search only the specific missing evidence, and
 * if no public RCA exists, root_cause_status stays undetermined. Absence of
 * a search result is never treated as expected-but-absent evidence, and no
 * cause is fabricated to fill the gap. Does not duplicate the full UI; only
 * the search -> candidate epistemics are exercised.
 */

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}
function fakeSearchClient(response: WebSearchResponse): WebSearchClient {
  return { responses: { create: async () => response } };
}
const fakeEmbedder = async (text: string) => ({ vector: Array.from({ length: 4 }, (_, i) => text.length + i), model: "fake-embedder" });

const CASE_ID = "case-google-secops-2026-negative";
const googleRequest = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
const googleExpected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");

test("Google negative: an empty search result produces zero candidates, never a fabricated one", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction({
    caseId: CASE_ID,
    investigationId: null,
    missingEvidenceId: googleExpected.missing_evidence[0]!.id,
    queryIntent: "Find a public root-cause statement for the Google SecOps data-freshness incident.",
    queries: ["Google SecOps data freshness incident root cause postmortem"],
    maxCandidates: 5,
    allowedDomains: null,
    idempotencyKey: "negative-key-1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // No citations at all -- the search genuinely found nothing usable.
  await performEvidenceScoutSearch(created.action.action_id, {
    store,
    client: fakeSearchClient({ output: [{ type: "message", content: [{ type: "output_text", text: "No relevant public source was found.", annotations: [] }] }] }),
  });

  const action = await store.getAction(created.action.action_id);
  assert.equal(action?.state, "completed");
  assert.equal(action?.candidates.length, 0, "no candidates must ever be fabricated to fill an empty result");
});

test("Google negative: a low-tier, source_located-only result stays ineligible -- a real follow-up without accepted Scout evidence keeps root_cause_status undetermined", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const preparedBaseline = prepareInvestigationRequest({ ...googleRequest, case_id: CASE_ID });
  assert.equal(preparedBaseline.ok, true);
  if (!preparedBaseline.ok) return;
  const memoryStore = new LocalMemoryStore(fakeEmbedder);
  const baselineResult = await runInvestigationFlow(
    preparedBaseline.request,
    memoryStore,
    () => Promise.resolve({ ok: true, investigation: { ...googleExpected, meta: { ...googleExpected.meta, case_id: CASE_ID } }, rawResponses: [] }),
  );
  assert.equal(baselineResult.ok, true);
  if (!baselineResult.ok) return;
  assert.equal(baselineResult.investigation.root_cause_status, "undetermined");

  const created = await store.createAction({
    caseId: CASE_ID,
    investigationId: null,
    missingEvidenceId: googleExpected.missing_evidence[0]!.id,
    queryIntent: "Find a public root-cause statement for the Google SecOps data-freshness incident.",
    queries: ["Google SecOps data freshness incident root cause"],
    maxCandidates: 5,
    allowedDomains: null,
    idempotencyKey: "negative-key-2",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // A citation exists but with no quotable, on-point excerpt: only a bare URL is found.
  await performEvidenceScoutSearch(created.action.action_id, {
    store,
    client: fakeSearchClient({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "See https://status.cloud.google.com/ for the incident history.", annotations: [{ type: "url_citation", url: "https://status.cloud.google.com/", title: "Status page", start_index: 0, end_index: 0 }] }],
      }],
    }),
  });
  const action = await store.getAction(created.action.action_id);
  assert.equal(action?.candidates.length, 1);
  assert.equal(action!.candidates[0]!.verification_status, "source_located");

  const preparedFollowUp = prepareInvestigationRequest({
    previous_snapshot: baselineResult.investigation,
    new_evidence: [{ label: "Search outcome note", content: "A public status page was located, but no acceptable public root-cause statement was found." }],
  });
  assert.equal(preparedFollowUp.ok, true);
  if (!preparedFollowUp.ok) return;
  assert.deepEqual(preparedFollowUp.request.evidence.map((evidence) => evidence.id), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11"]);
  assert.equal(preparedFollowUp.request.evidence[10]?.content, "A public status page was located, but no acceptable public root-cause statement was found.");
  const followUpResult = await runInvestigationFlow(
    preparedFollowUp.request,
    memoryStore,
    () => Promise.resolve({
      ok: true,
      investigation: {
        ...googleExpected,
        meta: { ...googleExpected.meta, case_id: CASE_ID, iteration: 2 },
        case: { ...googleExpected.case, evidence: preparedFollowUp.request.evidence },
      },
      rawResponses: [],
    }),
  );
  assert.equal(followUpResult.ok, true);
  if (!followUpResult.ok) return;

  // The absence of a resolvable public RCA is never smuggled into
  // expected_absent -- confirmed by the existing assertion contract still
  // holding after a real iteration-2 follow-up that carries no accepted
  // Scout evidence into the investigator.
  const assertions = evaluateCaseGoogleSecOps(preparedFollowUp.request, followUpResult.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
  assert.equal(followUpResult.investigation.root_cause_status, "undetermined");
  assert.equal(followUpResult.investigation.prime_suspect, null);
});
