import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifyMemoryLeads, SUSPECTED_DUPLICATE_REASON, type CurrentCaseIdentity } from "../lib/investigation-response";

/**
 * Fixture values below are byte-real, captured directly from the live
 * CockroachDB `investigation_memory` table (read-only inspection, 2026-08-14)
 * while diagnosing a production symptom: the Google SecOps investigation
 * showed itself as a "related precedent" alongside Cloudflare. Root cause was
 * not a comparison bug — classifyMemoryLeads compared case_id correctly at
 * every call site — it was a stray persisted row saved under a fabricated
 * case_id ("case-google-secops-debug-1786535778822") carrying byte-identical
 * case content to the real case-google-secops-2026 row. No code path in this
 * app generates "-debug-" case ids; the row was inserted directly.
 */
const googleSecOpsFixture = JSON.parse(readFileSync(new URL("../examples/case-google-secops-2026.json", import.meta.url), "utf8")) as {
  case_id: string; case_title: string; domain: string; observed_outcome: string; expected_behavior: string;
};

const currentCase: CurrentCaseIdentity = {
  caseId: googleSecOpsFixture.case_id,
  caseTitle: googleSecOpsFixture.case_title,
  domain: googleSecOpsFixture.domain,
  observedOutcome: googleSecOpsFixture.observed_outcome,
  expectedBehavior: googleSecOpsFixture.expected_behavior,
};

// Real row: the genuine Google SecOps case, iteration 1 (same case_id -> longitudinal).
const realSelfLead = {
  caseId: "case-google-secops-2026",
  investigationId: "07ec56bf-aa46-4d9e-9798-13a6d6d24e85",
  snapshotId: "0b73ff94-da26-4a5d-8b45-d6eae5c5f3fd",
  sourceId: "858186ea2f0d4d54b7e25026eac51f508bd11f6e4880ebeeec90fc642ef3d4f1",
  caseTitle: googleSecOpsFixture.case_title,
  domain: googleSecOpsFixture.domain,
  summary: "same-case longitudinal snapshot",
  isMock: false,
};

// Real row: the stray duplicate. Different case_id; byte-identical case text.
const realDebugDuplicateLead = {
  caseId: "case-google-secops-debug-1786535778822",
  investigationId: "749bf477-982e-4873-a512-3d51e32910de",
  snapshotId: "13d3a193-3ed9-4856-bf7d-05582341ab69",
  sourceId: "a19c25cfe2833a6fea460ec744201bf67ccf377f9de7ad79acbddd3991dd84eb",
  caseTitle: "Google SecOps data freshness delays, 31 Jul-1 Aug 2026",
  domain: "Cloud security operations incident",
  observedOutcome: googleSecOpsFixture.observed_outcome,
  expectedBehavior: googleSecOpsFixture.expected_behavior,
  summary: "Baseline confidences are set directly from the public record. H4 leads because the record itself states the root cause was under investigation and never later confirms one (E2, E10), which is direct support for an undetermined-cause conclusion rather than one that must be inferred. H1, H2, and H3 remain plausible and simultaneously active because they are not mutually exclusive candidate mechanisms and none is contradicted by the public evidence; each is capped below H4 because none has internal confirming data (M1, M2, M4) available. Resolution of the incident (E9, E10) is treated as operational recovery only, not as evidence for any specific mechanism.",
  isMock: false,
};

// Real row: a genuinely different case (Cloudflare) -> stays a related precedent.
const realCloudflareLead = {
  caseId: "case-cloudflare-waf-2019",
  investigationId: "5feb414e-9a9b-4c19-89c4-34ebd4663766",
  snapshotId: "70532815-c357-450a-95c3-0b5b88ee6bc7",
  sourceId: "d42eb18b5cb6e08a0699cd16c3a2dcb37175d9546b15d5af4219efcd741a814c",
  caseTitle: "Cloudflare global outage, 2 July 2019, 13:42-14:09 UTC",
  domain: "Internet infrastructure incident",
  observedOutcome: "Cloudflare's edge network returned HTTP 502 errors for HTTP and HTTPS traffic globally from 13:42 to 14:09 UTC on 2 July 2019 (27 minutes), with CPU utilization on machines handling HTTP/HTTPS traffic reaching close to 100%. Core proxying, CDN, and WAF functionality were unavailable for customers worldwide during this window.",
  expectedBehavior: "WAF rule changes are deployed globally within seconds via Cloudflare's Quicksilver config-distribution system; this is by design and bypasses the normal staged DOG/PIG/Canary rollout used for other software releases, because the WAF must respond rapidly to emerging threats. In exchange, the WAF release pipeline is expected to test each rule for runaway CPU utilization before it reaches production, and Cloudflare's edge software is expected to enforce a CPU-usage limit on any single regular expression evaluated against a request, so that one rule cannot consume unbounded CPU on a machine.",
  summary: "Baseline confidences place H2 first because E1 identifies a backtracking-prone rule, E6 attributes CPU consumption to the WAF, E10 identifies removal of the intended CPU limiter, and E2/E11 identify the omitted CPU test.",
  isMock: false,
};

test("real Google SecOps payload: debug duplicate is excluded from related and from longitudinal, and flagged as a suspected duplicate", () => {
  const classified = classifyMemoryLeads([realSelfLead, realDebugDuplicateLead, realCloudflareLead], currentCase);

  assert.deepEqual(classified.related.map((item) => item.caseId), ["case-cloudflare-waf-2019"]);
  assert.deepEqual(classified.longitudinal.map((item) => item.caseId), ["case-google-secops-2026"]);
  assert.deepEqual(classified.suspectedDuplicates.map((item) => item.caseId), ["case-google-secops-debug-1786535778822"]);
  assert.equal(classified.unclassified.length, 0);

  const duplicate = classified.suspectedDuplicates[0]!;
  assert.equal(duplicate.reason, SUSPECTED_DUPLICATE_REASON);
  assert.equal(duplicate.reason, "different case_id with matching canonical case fingerprint");
  assert.match(duplicate.summary, /\bH4\b/); // the stale H4 text the symptom was reported against
});

test("multiple snapshots of the same external case collapse to the latest and are not marked as suspected duplicates", () => {
  const olderCloudflareLead = {
    ...realCloudflareLead,
    investigationId: "e30dc7f3-e07f-4958-9c1d-eed522331cb9",
    snapshotId: "0638c25f-feeb-4e95-97bf-385120ceac81",
    sourceId: "",
    caseTitle: "Cloudflare global outage, 2 July 2019, 13:42-14:09 UTC",
    summary: "older Cloudflare snapshot",
    iteration: 1,
    createdAt: "2026-08-12T09:52:19.467025Z",
  };
  const latestCloudflareLead = {
    ...realCloudflareLead,
    snapshotId: "fac9dc66-df1e-4a37-b2a9-747443a478f8",
    sourceId: "b1f0f656bcc00b76b3871a3c2700eca1cf3917ab5c1b7f5ebd8e9e1d4e30f556",
    caseTitle: "Cloudflare global WAF outage, 2 July 2019",
    summary: "latest Cloudflare snapshot",
    iteration: 1,
    createdAt: "2026-08-14T15:17:34.481792Z",
  };

  const classified = classifyMemoryLeads([olderCloudflareLead, latestCloudflareLead, realDebugDuplicateLead], currentCase);

  assert.deepEqual(classified.related.map((item) => item.caseId), ["case-cloudflare-waf-2019"]);
  assert.deepEqual(classified.related.map((item) => item.snapshotId), ["fac9dc66-df1e-4a37-b2a9-747443a478f8"]);
  assert.equal(classified.suspectedDuplicates.length, 1);
  assert.deepEqual(classified.suspectedDuplicates.map((item) => item.caseId), ["case-google-secops-debug-1786535778822"]);
});

test("control: same title but a genuinely different outcome/source is not auto-declared a duplicate", () => {
  const sameTitleDifferentCase = {
    caseId: "case-google-secops-2027-recurrence",
    investigationId: "i-recur",
    snapshotId: "s-recur",
    sourceId: "src-recur",
    caseTitle: googleSecOpsFixture.case_title, // identical title
    domain: googleSecOpsFixture.domain,
    observedOutcome: "Google SecOps customers experienced a completely separate ingestion delay from 2027-03-02 08:00 UTC to 2027-03-02 09:15 UTC, isolated to the Rule re-evaluation pipeline in a single region, per status.cloud.google.com/security/incidents/differentIncidentId.",
    expectedBehavior: "Rule re-evaluation is expected to complete within minutes of ingestion for every region.",
    summary: "A different incident that happens to share a title.",
    isMock: false,
  };

  const classified = classifyMemoryLeads([sameTitleDifferentCase], currentCase);
  assert.deepEqual(classified.related.map((item) => item.caseId), ["case-google-secops-2027-recurrence"]);
  assert.equal(classified.suspectedDuplicates.length, 0);
});

test("control: different case_id with an identical fingerprint is a suspected duplicate", () => {
  const classified = classifyMemoryLeads([realDebugDuplicateLead], currentCase);
  assert.equal(classified.suspectedDuplicates.length, 1);
  assert.equal(classified.related.length, 0);
});

test("control: same case_id is longitudinal continuity, never related or a duplicate", () => {
  const classified = classifyMemoryLeads([realSelfLead], currentCase);
  assert.equal(classified.longitudinal.length, 1);
  assert.equal(classified.related.length, 0);
  assert.equal(classified.suspectedDuplicates.length, 0);
});

test("control: incomplete identity is unclassified, not silently dropped or promoted", () => {
  const missingSourceId = { caseId: "some-case", investigationId: "i", snapshotId: "s", domain: "d", caseTitle: "Some case", summary: "s", isMock: false };
  const classified = classifyMemoryLeads([missingSourceId], currentCase);
  assert.equal(classified.unclassified.length, 1);
  assert.equal(classified.related.length, 0);
  assert.equal(classified.suspectedDuplicates.length, 0);
});

test("control: high vector similarity without an identical fingerprint stays a related precedent, not a duplicate", () => {
  const highSimilarityButDifferentCase = {
    caseId: "case-lookalike",
    investigationId: "i-look",
    snapshotId: "s-look",
    sourceId: "src-look",
    caseTitle: googleSecOpsFixture.case_title,
    domain: googleSecOpsFixture.domain,
    observedOutcome: "A superficially similar but factually distinct data-freshness incident affecting a different product line entirely, with no shared dates or sources.",
    expectedBehavior: "Data should remain fresh at all times for the unrelated product line in question.",
    summary: "Looks similar in the vector index but is not the same case.",
    isMock: false,
    similarityScore: 0.0001, // deliberately near-zero L2 distance
    whyRelevant: "Semantically closest prior investigation (L2 distance 0.0001).",
  };

  const classified = classifyMemoryLeads([highSimilarityButDifferentCase], currentCase);
  assert.deepEqual(classified.related.map((item) => item.caseId), ["case-lookalike"]);
  assert.equal(classified.suspectedDuplicates.length, 0);
});
