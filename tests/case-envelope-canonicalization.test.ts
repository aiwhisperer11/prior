import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type OpenAI from "openai";

import { evaluateCaseB } from "../lib/server/case-b-assertions";
import { evaluateCaseCloudflareWaf } from "../lib/server/case-cloudflare-waf-assertions";
import { evaluateCaseGoogleSecOps } from "../lib/server/case-google-secops-assertions";
import { runInvestigationFlow } from "../lib/server/investigation-flow";
import type { InvestigationMemoryStore, PrecedentLead, StoredInvestigation } from "../lib/server/memory-store";
import { prepareInvestigationRequest, runSherlockInvestigation } from "../lib/server/sherlock-engine";
import { normalizeEvidenceLedger } from "../lib/investigation-presentation";
import type { InvestigationRequest, SherlockInvestigation } from "../types/sherlock";

/**
 * Regression coverage for the Case Envelope canonicalization boundary
 * (lib/server/sherlock-engine.ts: applyCanonicalCaseEnvelope). Every test
 * here feeds runSherlockInvestigation a model response that echoes the case
 * back wrong on purpose — a dropped URL, reworded evidence, invented or
 * deleted evidence items, a different case_id — and asserts the final
 * SherlockInvestigation still carries the server's original values. Without
 * the boundary, every one of these is red: the model's echo simply overwrites
 * the prepared request.
 */

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

function fakeClient(responses: string[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: responses.shift() ?? null } }] }),
      },
    },
  } as unknown as OpenAI;
}

const googleRequest = readJson<InvestigationRequest>("../examples/case-google-secops-2026.json");
const OFFICIAL_URL = "status.cloud.google.com/security/incidents/wCAYU8nZcNY1sMVJPb7p";

/**
 * Built from the tracked, vetted fixture (examples/case-google-secops-2026.
 * expected-investigation.json), not a captured live-run artifact -- the test
 * suite must not depend on anything under .sherlock/ (gitignored, not
 * reproducible in a fresh checkout or CI). This deterministically reproduces
 * the same class of failure a live run exhibited: expected_behavior loses
 * its only source anchor (the status-page URL) AND every evidence item's
 * label/content is reworded, in the same response.
 */
function googleGarbledCaseText(): SherlockInvestigation {
  const base = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  assert.match(base.case.expected_behavior, new RegExp(OFFICIAL_URL.replace(/[/.]/g, "\\$&")), "fixture must actually contain the URL before this test strips it");
  return {
    ...base,
    case: {
      ...base.case,
      expected_behavior: base.case.expected_behavior.replace(/\s*\(status\.cloud\.google\.com[^)]*\)/, ""),
      evidence: base.case.evidence.map((evidence) => ({
        ...evidence,
        label: `Model paraphrase of ${evidence.label}`,
        content: `Reworded by the model: ${evidence.content}`,
      })),
    },
  };
}

test("a model response that drops the official URL from expected_behavior does not lose it in the final investigation", async () => {
  const garbled = googleGarbledCaseText();
  assert.doesNotMatch(garbled.case.expected_behavior, /status\.cloud\.google\.com/, "the garbled fixture must not contain the URL");

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(garbled)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.investigation.case.expected_behavior, googleRequest.expected_behavior);
  assert.match(result.investigation.case.expected_behavior, /status\.cloud\.google\.com\/security\/incidents\/wCAYU8nZcNY1sMVJPb7p/);
});

test("a model response that reformulates evidence labels/content is discarded; the final investigation keeps the exact input values", async () => {
  const garbled = googleGarbledCaseText();
  // Confirm the fixture really did reformulate labels/content relative to the request, otherwise this test proves nothing.
  assert.notDeepEqual(
    garbled.case.evidence.map((e) => [e.label, e.content]),
    googleRequest.evidence.map((e) => [e.label, e.content]),
  );

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(garbled)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.investigation.case.evidence,
    googleRequest.evidence.map((e) => ({ id: e.id, label: e.label, content: e.content, provided_in_iteration: 1 })),
  );
});

test("the model cannot add, remove, duplicate, or renumber evidence items", async () => {
  const base = googleGarbledCaseText();
  const tampered: SherlockInvestigation = {
    ...base,
    case: {
      ...base.case,
      evidence: [
        base.case.evidence[0]!, // E1 kept
        { ...base.case.evidence[1]!, id: "E1" }, // duplicate id
        // E3..E9 dropped entirely
        { ...base.case.evidence[9]!, id: "E50" }, // renumbered E10 -> E50
        { id: "E99", label: "Invented follow-up", content: "The model invented this evidence item.", provided_in_iteration: 1 }, // invented
      ],
    },
  };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(tampered)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.investigation.case.evidence.map((e) => e.id), googleRequest.evidence.map((e) => e.id));
  assert.equal(result.investigation.case.evidence.length, 10);
});

test("Google E1-E10 classify as source_claim / verified_as_published / high even after the model garbles expected_behavior and evidence", async () => {
  const garbled = googleGarbledCaseText();
  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(garbled)]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const ledger = normalizeEvidenceLedger(result.investigation);
  assert.equal(ledger.length, 10);
  for (const record of ledger) {
    assert.equal(record.assertion_type, "source_claim", `${record.id} should be source_claim`);
    assert.equal(record.verification_status, "verified_as_published", `${record.id} should be verified_as_published`);
    assert.equal(record.source_reliability, "high", `${record.id} should be high reliability`);
    assert.equal(record.source.url, `https://${OFFICIAL_URL}`);
  }
});

test("follow-up preserves exact prior evidence and adds only server-numbered new evidence, even when the model tries to tamper with it", async () => {
  const caseBRequest = readJson<InvestigationRequest>("../examples/case-b.json");
  const iteration1Expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const iteration2Snapshot = readJson<SherlockInvestigation>("../examples/case-b-iteration2-snapshot.json");
  const newEvidence = readJson<Array<{ label: string; content: string }>>("../examples/case-b-evidence-e5.json");

  const prepared1 = prepareInvestigationRequest(caseBRequest);
  assert.equal(prepared1.ok, true);
  if (!prepared1.ok) return;

  // The model renames E1, deletes E3, and duplicates E4 in its iteration-1 response.
  const tamperedIteration1: SherlockInvestigation = {
    ...iteration1Expected,
    case: {
      ...iteration1Expected.case,
      evidence: [
        { ...iteration1Expected.case.evidence[0]!, label: "Renamed by the model" },
        iteration1Expected.case.evidence[1]!,
        iteration1Expected.case.evidence[3]!,
        iteration1Expected.case.evidence[3]!,
      ],
    },
  };
  const result1 = await runSherlockInvestigation(prepared1.request, fakeClient([JSON.stringify(tamperedIteration1)]));
  assert.equal(result1.ok, true);
  if (!result1.ok) return;
  assert.deepEqual(result1.investigation.case.evidence, prepared1.request.evidence);

  const prepared2 = prepareInvestigationRequest({
    previous_snapshot: result1.investigation,
    new_evidence: newEvidence,
  });
  assert.equal(prepared2.ok, true);
  if (!prepared2.ok) return;
  assert.equal(prepared2.request.evidence.length, 5);
  assert.equal(prepared2.request.evidence.at(-1)?.id, "E5");

  // The model renames E1 again, drops E3, duplicates E5, and invents E99 in its iteration-2 response.
  const tamperedIteration2: SherlockInvestigation = {
    ...iteration2Snapshot,
    case: {
      ...iteration2Snapshot.case,
      evidence: [
        { ...prepared2.request.evidence[0]!, label: "Renamed again" },
        prepared2.request.evidence[1]!,
        prepared2.request.evidence[3]!,
        prepared2.request.evidence[4]!,
        prepared2.request.evidence[4]!,
        { id: "E99", label: "Invented", content: "Invented content.", provided_in_iteration: 2 },
      ],
    },
  };
  const result2 = await runSherlockInvestigation(prepared2.request, fakeClient([JSON.stringify(tamperedIteration2)]));
  assert.equal(result2.ok, true);
  if (!result2.ok) return;

  // Exactly the four prior canonical items plus the one new, server-numbered item — nothing renamed, dropped, duplicated, or invented.
  assert.deepEqual(result2.investigation.case.evidence.slice(0, 4), result1.investigation.case.evidence);
  assert.deepEqual(result2.investigation.case.evidence.map((e) => e.id), ["E1", "E2", "E3", "E4", "E5"]);
  assert.equal(result2.investigation.case.evidence[4]?.label, newEvidence[0]?.label);
  assert.equal(result2.investigation.case.evidence[4]?.content, newEvidence[0]?.content);
  assert.equal(result2.investigation.case.evidence[4]?.provided_in_iteration, 2);
});

test("Case B keeps its assertion contract when the model echoes the wrong case_id, title, domain, and case text", async () => {
  const request = readJson<InvestigationRequest>("../examples/case-b.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const garbled: SherlockInvestigation = {
    ...expected,
    meta: { case_id: "wrong-id", case_title: "Wrong title", domain: "Wrong domain", iteration: 7 },
    case: {
      observed_outcome: "A paraphrase the model invented instead of echoing the request.",
      expected_behavior: "A paraphrase the model invented instead of echoing the request.",
      evidence: expected.case.evidence.map((e) => ({ ...e, label: `${e.label} (reworded)`, content: `${e.content} (summarized)` })),
    },
  };

  const result = await runSherlockInvestigation({ ...request, iteration: 1 } as never, fakeClient([JSON.stringify(garbled)]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.investigation.meta.case_id, request.case_id);
  assert.equal(result.investigation.meta.case_title, request.case_title);
  assert.equal(result.investigation.meta.domain, request.domain);
  assert.equal(result.investigation.case.observed_outcome, request.observed_outcome);
  assert.equal(result.investigation.case.expected_behavior, request.expected_behavior);

  const assertions = evaluateCaseB(request, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("Cloudflare keeps its assertion contract when the model echoes reworded case text and evidence", async () => {
  const request = readJson<InvestigationRequest>("../examples/case-cloudflare-waf-2019.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-cloudflare-waf-2019.expected-investigation.json");
  const garbled: SherlockInvestigation = {
    ...expected,
    case: {
      ...expected.case,
      expected_behavior: "A reworded expectation the model invented instead of echoing the request.",
      evidence: expected.case.evidence.map((e) => ({ ...e, content: `${e.content} (paraphrased by the model)` })),
    },
  };

  const result = await runSherlockInvestigation({ ...request, iteration: 1 } as never, fakeClient([JSON.stringify(garbled)]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.investigation.case.expected_behavior, request.expected_behavior);
  assert.deepEqual(
    result.investigation.case.evidence.map((e) => e.content),
    request.evidence.map((e) => e.content),
  );

  const assertions = evaluateCaseCloudflareWaf(request, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("Google SecOps keeps its assertion contract through the same canonicalization boundary", async () => {
  const expected = readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
  const garbled = googleGarbledCaseText();
  // Keep the vetted reasoning fields (hypotheses, matrix, etc.) but the garbled case/meta.
  const candidate: SherlockInvestigation = { ...expected, meta: garbled.meta, case: garbled.case };

  const result = await runSherlockInvestigation({ ...googleRequest, iteration: 1 } as never, fakeClient([JSON.stringify(candidate)]));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const assertions = evaluateCaseGoogleSecOps(googleRequest, result.investigation);
  assert.deepEqual(assertions.filter((a) => !a.passed), [], JSON.stringify(assertions, null, 2));
});

test("persistence, the API response, and the UI all read the identical canonical Case Envelope from the same object", async () => {
  const request = readJson<InvestigationRequest>("../examples/case-b.json");
  const expected = readJson<SherlockInvestigation>("../examples/case-b.expected-investigation.json");
  const garbled: SherlockInvestigation = {
    ...expected,
    meta: { case_id: "wrong-id", case_title: "Wrong title", domain: "Wrong domain", iteration: 7 },
    case: { observed_outcome: "wrong", expected_behavior: "wrong", evidence: [] },
  };

  const saved: StoredInvestigation[] = [];
  const store: InvestigationMemoryStore = {
    findPrecedents: async (): Promise<PrecedentLead[]> => [],
    save: async (record) => { saved.push(record); },
  };

  const result = await runInvestigationFlow(
    { ...request, iteration: 1 } as never,
    store,
    (req) => runSherlockInvestigation(req, fakeClient([JSON.stringify(garbled)])),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The exact object persisted is the exact object the API route serializes back to the client (and the UI renders).
  assert.equal(saved[0]?.investigation, result.investigation);
  assert.equal(result.investigation.meta.case_id, request.case_id);
  assert.equal(result.investigation.case.observed_outcome, request.observed_outcome);
  assert.deepEqual(
    result.investigation.case.evidence.map((e) => e.id),
    request.evidence.map((e) => e.id),
  );
});

/**
 * Referential integrity: replacing case.evidence wholesale (above) neutralizes
 * a model-invented evidence item sitting in case.evidence itself, but it does
 * nothing about the model's *reasoning* pointing at an id that was never
 * canonical to begin with (E99) — every collection below is a distinct place
 * that reasoning can smuggle such a reference in. Each must independently
 * cause a retry, and rejection if the retry doesn't fix it, before the result
 * ever reaches persistence, the API response, or the UI.
 */

function googleExpected(): SherlockInvestigation {
  return readJson<SherlockInvestigation>("../examples/case-google-secops-2026.expected-investigation.json");
}

const DANGLING_REFERENCE_MUTATIONS: Array<{ name: string; mutate: (investigation: SherlockInvestigation) => SherlockInvestigation }> = [
  {
    name: "hypotheses[].supported_by[].evidence_id",
    mutate: (investigation) => ({
      ...investigation,
      hypotheses: investigation.hypotheses.map((h, i) => (i === 0 ? { ...h, supported_by: [...h.supported_by, { evidence_id: "E99", reason: "Invented by the model." }] } : h)),
    }),
  },
  {
    name: "hypotheses[].contradicted_by[].evidence_id",
    mutate: (investigation) => ({
      ...investigation,
      hypotheses: investigation.hypotheses.map((h, i) => (i === 0 ? { ...h, contradicted_by: [...h.contradicted_by, { evidence_id: "E99", reason: "Invented by the model." }] } : h)),
    }),
  },
  {
    name: "hypotheses[].killed_by (evidence-id-shaped)",
    mutate: (investigation) => ({
      ...investigation,
      hypotheses: investigation.hypotheses.map((h, i) => (i === 0 ? { ...h, status: "rejected" as const, killed_by: "E99", resurrection_condition: "New telemetry naming a different mechanism." } : h)),
    }),
  },
  {
    name: "expectation_matrix.expected_present[].evidence_ids",
    mutate: (investigation) => ({
      ...investigation,
      expectation_matrix: { ...investigation.expectation_matrix, expected_present: investigation.expectation_matrix.expected_present.map((item, i) => (i === 0 ? { ...item, evidence_ids: [...item.evidence_ids, "E99"] } : item)) },
    }),
  },
  {
    name: "expectation_matrix.unexpected_present[].evidence_ids",
    mutate: (investigation) => ({
      ...investigation,
      expectation_matrix: { ...investigation.expectation_matrix, unexpected_present: investigation.expectation_matrix.unexpected_present.map((item, i) => (i === 0 ? { ...item, evidence_ids: [...item.evidence_ids, "E99"] } : item)) },
    }),
  },
  {
    name: "expectation_matrix.expected_absent[].evidence_ids",
    mutate: (investigation) => ({
      ...investigation,
      expectation_matrix: { ...investigation.expectation_matrix, expected_absent: investigation.expectation_matrix.expected_absent.map((item, i) => (i === 0 ? { ...item, evidence_ids: [...item.evidence_ids, "E99"] } : item)) },
    }),
  },
  {
    name: "expectation_matrix.unexpected_absent[].evidence_ids",
    // Appended rather than mutating an existing item: unexpected_absent may
    // legitimately be empty (the P3 grounding fix removed Google's only
    // entry), so this must not depend on one already being there.
    mutate: (investigation) => ({
      ...investigation,
      expectation_matrix: {
        ...investigation.expectation_matrix,
        unexpected_absent: [
          ...investigation.expectation_matrix.unexpected_absent,
          { id: "X900", description: "Invented by the model.", evidence_ids: ["E1", "E99"], significance: "Invented by the model.", related_hypothesis_ids: [] },
        ],
      },
    }),
  },
];

for (const { name, mutate } of DANGLING_REFERENCE_MUTATIONS) {
  test(`a model-invented E99 referenced from ${name} is retried and rejected before persisting, serializing, or rendering`, async () => {
    const tampered = mutate(googleExpected());

    const result = await runSherlockInvestigation(
      { ...googleRequest, iteration: 1 } as never,
      fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)]),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "validation");
    assert.ok(
      result.validationErrors.some((e) => e.keyword === "evidence_reference" && e.message?.includes("E99")),
      JSON.stringify(result.validationErrors),
    );
  });
}

test("a dangling E99 reference on the first attempt is retried, and a clean second response is accepted", async () => {
  const clean = googleExpected();
  const tampered = DANGLING_REFERENCE_MUTATIONS[0]!.mutate(clean);

  const result = await runSherlockInvestigation(
    { ...googleRequest, iteration: 1 } as never,
    fakeClient([JSON.stringify(tampered), JSON.stringify(clean)]),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.investigation.case.evidence.map((e) => e.id), googleRequest.evidence.map((e) => e.id));
});

test("a persistent E99 reference is never persisted, never reaches the API response, and store.save is never called", async () => {
  const tampered = DANGLING_REFERENCE_MUTATIONS[0]!.mutate(googleExpected());
  const saved: StoredInvestigation[] = [];
  const store: InvestigationMemoryStore = {
    findPrecedents: async (): Promise<PrecedentLead[]> => [],
    save: async (record) => { saved.push(record); },
  };

  const result = await runInvestigationFlow(
    { ...googleRequest, iteration: 1 } as never,
    store,
    (req) => runSherlockInvestigation(req, fakeClient([JSON.stringify(tampered), JSON.stringify(tampered)])),
  );

  assert.equal(result.ok, false);
  assert.equal(saved.length, 0);
});
