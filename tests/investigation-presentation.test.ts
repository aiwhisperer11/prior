import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveExecutiveSummary, executiveEvidenceIds, normalizeEvidenceLedger } from "../lib/investigation-presentation";
import { classifyMemoryLeads, parseInvestigationApiResponse, type MemoryLineageView } from "../lib/investigation-response";
import { auditArtifactVerificationLabel, nextPresentationView } from "../components/InvestigationPresentation";
import SherlockInvestigationView from "../components/SherlockInvestigationView";
import ExpectationMatrix from "../components/ExpectationMatrix";
import type { FalsificationExpectationMatrix, SherlockInvestigation } from "../types/sherlock";

const google = JSON.parse(readFileSync(new URL("../examples/case-google-secops-2026.expected-investigation.json", import.meta.url), "utf8")) as SherlockInvestigation;

test("presentation read-model keeps an undetermined investigation without a prime suspect", () => {
  const summary = deriveExecutiveSummary(google);
  assert.equal(summary.causal_assessment.root_cause_status, "undetermined");
  assert.equal(summary.causal_assessment.prime_suspect_id, null);
  assert.match(summary.demonstrated_impact, /incomplete Search results/i);
  assert.notEqual(summary.issue_overview, summary.demonstrated_impact);
  assert.deepEqual(executiveEvidenceIds(google), ["E2", "E10"]);
});

test("presentation rejects stale self-precedents and exposes keyboard tab order", () => {
  const currentCase = { caseId: google.meta.case_id, caseTitle: google.meta.case_title, domain: google.meta.domain, observedOutcome: google.case.observed_outcome, expectedBehavior: google.case.expected_behavior };
  // Exact post-mapping legacy shape: title/summary survived, canonical IDs did not.
  const exactLegacyCockroachShape = { caseTitle: "Google SecOps data freshness delays", domain: "Cloud security operations incident", summary: "legacy result", similarityScore: 0.12, isMock: false };
  const classified = classifyMemoryLeads([{ caseId: google.meta.case_id, investigationId: "i", snapshotId: "s", sourceId: "src", domain: "d", caseTitle: "self", summary: "s", isMock: false }, exactLegacyCockroachShape, { caseId: "other", investigationId: "i2", snapshotId: "s2", sourceId: "src2", domain: "d", caseTitle: "other", summary: "s", isMock: false }], currentCase);
  assert.deepEqual(classified.related.map((item) => item.caseId), ["other"]);
  assert.deepEqual(classified.longitudinal.map((item) => item.caseId), [google.meta.case_id]);
  assert.equal(classified.suspectedDuplicates.length, 0);
  assert.equal(classified.unclassified.length, 1);
  assert.equal(nextPresentationView("executive", "ArrowLeft"), "audit");
  assert.equal(nextPresentationView("audit", "Home"), "executive");
  assert.equal(nextPresentationView("investigator", "End"), "audit");
});

test("full Investigator tree uses the ledger and does not render the legacy case-evidence list or H4", () => {
  const html = renderToStaticMarkup(createElement(SherlockInvestigationView, { investigation: google, showLegacyEvidence: false }));
  assert.doesNotMatch(html, /Case evidence/);
  assert.doesNotMatch(html, /<li[^>]*>\s*<\/li>/);
  assert.doesNotMatch(html, /\bH4\b/);
});

test("legacy evidence normalizes to a complete, non-upgraded ledger", () => {
  const ledger = normalizeEvidenceLedger(google);
  assert.equal(ledger.length, 10);
  assert.deepEqual(ledger.map((item) => item.id), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"]);
  assert.equal(ledger[0]?.assertion_type, "source_claim");
  assert.equal(ledger[0]?.verification_status, "verified_as_published");
  assert.equal(ledger[0]?.source_reliability, "high");
});

test("evidence classification does not depend on literal 'status update' wording in the model-authored label", () => {
  // Real shape observed from a live model run: expected_behavior declares the
  // single public source, but per-item labels are the model's own paraphrase
  // ("Stats Search delay identified") rather than "Status update, <time>".
  const investigation = {
    case: {
      observed_outcome: "irrelevant to this check",
      expected_behavior: "The only evidence available for this investigation is Google's own public status page (status.cloud.google.com/security/incidents/wCAYU8nZcNY1sMVJPb7p); no internal engineering telemetry is publicly available.",
      evidence: [
        { id: "E1", label: "Initial status update", content: "content 1", provided_in_iteration: 1 },
        { id: "E2", label: "Stats Search delay identified", content: "content 2", provided_in_iteration: 1 },
        { id: "E10", label: "Resolution update", content: "content 10", provided_in_iteration: 1 },
      ],
    },
    hypotheses: [],
  } as unknown as SherlockInvestigation;

  const ledger = normalizeEvidenceLedger(investigation);
  for (const record of ledger) {
    assert.equal(record.assertion_type, "source_claim", `${record.id} should be source_claim regardless of label wording`);
    assert.equal(record.verification_status, "verified_as_published");
    assert.equal(record.source_reliability, "high");
    assert.equal(record.source.url, "https://status.cloud.google.com/security/incidents/wCAYU8nZcNY1sMVJPb7p");
  }
});

test("evidence classification falls back to per-item heuristics when the case does not declare a single public source", () => {
  const investigation = {
    case: {
      observed_outcome: "irrelevant to this check",
      expected_behavior: "Internal engineering systems are expected to behave normally; no single named public source is declared.",
      evidence: [{ id: "E1", label: "Pull request log", content: "content", provided_in_iteration: 1 }],
    },
    hypotheses: [],
  } as unknown as SherlockInvestigation;

  const ledger = normalizeEvidenceLedger(investigation);
  assert.equal(ledger[0]?.assertion_type, "measurement");
  assert.equal(ledger[0]?.verification_status, "unverified");
  assert.equal(ledger[0]?.source_reliability, "unknown");
  assert.equal(ledger[0]?.source.url, null);
});

test("ExpectationMatrix omits the 'Why it matters' disclosure for an item with empty significance", () => {
  const matrix: FalsificationExpectationMatrix = {
    expected_present: [],
    unexpected_present: [],
    expected_absent: [{ id: "X1", description: "thin item", evidence_ids: [], significance: "", related_hypothesis_ids: [] }],
    unexpected_absent: [{ id: "X2", description: "full item", evidence_ids: [], significance: "This matters because it is directly anchored to the expected behavior.", related_hypothesis_ids: [] }],
  };
  const html = renderToStaticMarkup(createElement(ExpectationMatrix, { matrix }));
  const occurrences = html.match(/Why it matters/g) ?? [];
  assert.equal(occurrences.length, 1, "only the item with non-empty significance should render the disclosure");
});

test("auditArtifactVerificationLabel reports 'verified' only when key, sha256, backend, and verified_at are all present", () => {
  const verifiedMemory: MemoryLineageView = {
    snapshotId: "s", investigationId: "i", parentSnapshotId: null, sourceId: "src",
    modelVersion: "m", promptVersion: "p", embeddingModel: "e",
    auditArtifactKey: "investigations/case-x/i/s.json", auditArtifactSha256: "a".repeat(64),
    auditStorageBackend: "s3", auditArtifactVersionId: "v1", auditArtifactVerifiedAt: "2026-08-15T00:00:00.000Z",
    auditVerificationStatus: "verified",
  };
  assert.equal(auditArtifactVerificationLabel(verifiedMemory), "verified");
  assert.equal(auditArtifactVerificationLabel(null), "not available");
  assert.equal(
    auditArtifactVerificationLabel({ ...verifiedMemory, auditArtifactKey: null, auditArtifactSha256: null, auditVerificationStatus: "not_available" }),
    "not available",
  );
  // A local write has no version_id at all, but is still fully verified.
  assert.equal(auditArtifactVerificationLabel({ ...verifiedMemory, auditStorageBackend: "local", auditArtifactVersionId: null }), "verified");
});

test("a legacy API response with no audit artifact fields on memory parses cleanly and reports 'not available', never 'verified'", () => {
  const body = {
    investigation: google,
    precedents: [],
    unclassified_memory: [],
    suspected_duplicate_memory: [],
    storage: "cockroachdb",
    memory_is_lead_not_evidence: true,
    memory: {
      snapshotId: "s", investigationId: "i", parentSnapshotId: null, sourceId: "src",
      modelVersion: "m", promptVersion: "p", embeddingModel: "e",
      // No auditArtifactKey/auditArtifactSha256/auditStorageBackend at all --
      // exactly what a pre-migration-003 row, or an older API version, sends.
    },
  };
  const parsed = parseInvestigationApiResponse(body);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.response.memory?.auditArtifactKey, null);
  assert.equal(parsed.response.memory?.auditArtifactSha256, null);
  assert.equal(parsed.response.memory?.auditStorageBackend, null);
  assert.equal(parsed.response.memory?.auditVerificationStatus, "not_available");
  assert.equal(auditArtifactVerificationLabel(parsed.response.memory), "not available");
});

test("a fresh API response with a verified artifact reports 'verified' and exposes only safe lineage fields", () => {
  const body = {
    investigation: google,
    precedents: [],
    unclassified_memory: [],
    suspected_duplicate_memory: [],
    storage: "cockroachdb",
    memory_is_lead_not_evidence: true,
    memory: {
      snapshotId: "s", investigationId: "i", parentSnapshotId: null, sourceId: "src",
      modelVersion: "m", promptVersion: "p", embeddingModel: "e",
      auditArtifactKey: "investigations/case-x/i/s.json", auditArtifactSha256: "a".repeat(64), auditStorageBackend: "s3",
      auditArtifactVersionId: "s3-version-1", auditArtifactVerifiedAt: "2026-08-15T00:00:00.000Z",
    },
  };
  const parsed = parseInvestigationApiResponse(body);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.response.memory?.auditVerificationStatus, "verified");
  assert.equal(auditArtifactVerificationLabel(parsed.response.memory), "verified");

  const memoryKeys = Object.keys(parsed.response.memory ?? {}).sort();
  assert.deepEqual(memoryKeys, [
    "auditArtifactKey", "auditArtifactSha256", "auditStorageBackend", "auditArtifactVersionId", "auditArtifactVerifiedAt", "auditVerificationStatus",
    "embeddingModel", "investigationId", "modelVersion", "parentSnapshotId", "promptVersion", "snapshotId", "sourceId",
  ].sort());
  for (const forbidden of ["bucket", "region", "prefix", "credential", "accessKey", "secret", "url", "presigned"]) {
    assert.ok(!memoryKeys.some((key) => key.toLowerCase().includes(forbidden.toLowerCase())), `memory lineage must never expose a "${forbidden}"-shaped field`);
  }
});
