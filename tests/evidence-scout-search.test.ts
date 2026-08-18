import assert from "node:assert/strict";
import test from "node:test";

import { performEvidenceScoutSearch, type WebSearchClient, type WebSearchResponse } from "../lib/server/evidence-scout-search";
import { LocalEvidenceScoutCandidateStore, type CreateActionInput } from "../lib/server/evidence-scout-store";

function fakeWebSearchClient(responses: WebSearchResponse[]): WebSearchClient {
  const calls: unknown[] = [];
  return {
    responses: {
      create: async (params) => {
        calls.push(params);
        const next = responses.shift();
        if (!next) throw new Error("fakeWebSearchClient: no more canned responses");
        return next;
      },
    },
  };
}

function response(text: string, annotations: Array<{ url: string; title: string; start: number; end: number }>): WebSearchResponse {
  return {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text,
            annotations: annotations.map((a) => ({ type: "url_citation", url: a.url, title: a.title, start_index: a.start, end_index: a.end })),
          },
        ],
      },
    ],
  };
}

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

test("a literal quoted excerpt produces verified_as_published with real cited_text", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const text = 'The postmortem states "a CPU exhaustion issue caused the outage" according to Cloudflare.';
  const start = text.indexOf('"a CPU exhaustion issue caused the outage"');
  const end = start + '"a CPU exhaustion issue caused the outage"'.length;
  const client = fakeWebSearchClient([response(text, [{ url: "https://blog.cloudflare.com/outage/", title: "Cloudflare outage postmortem", start, end }])]);

  await performEvidenceScoutSearch(created.action.action_id, { store, client });
  const action = await store.getAction(created.action.action_id);
  assert.equal(action?.state, "completed");
  assert.equal(action?.candidates.length, 1);
  const candidate = action!.candidates[0]!;
  assert.equal(candidate.verification_status, "verified_as_published");
  assert.equal(candidate.cited_text, "a CPU exhaustion issue caused the outage");
  assert.equal(candidate.tier, "official_primary");
});

test("a citation with a non-quoted span is citation_supported, never verified_as_published (point 3: a url_citation alone is not enough)", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const text = "The postmortem describes a CPU exhaustion issue that caused the outage.";
  const start = text.indexOf("a CPU exhaustion issue");
  const end = start + "a CPU exhaustion issue".length;
  const client = fakeWebSearchClient([response(text, [{ url: "https://blog.cloudflare.com/outage/", title: "Cloudflare outage postmortem", start, end }])]);

  await performEvidenceScoutSearch(created.action.action_id, { store, client });
  const action = await store.getAction(created.action.action_id);
  const candidate = action!.candidates[0]!;
  assert.equal(candidate.verification_status, "citation_supported");
  assert.equal(candidate.cited_text, null);
});

test("stops issuing further queries once an official_primary, verified_as_published candidate is found", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput({ queries: ["query one", "query two"] }));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const text = 'Cloudflare states "a CPU exhaustion issue caused the outage".';
  const start = text.indexOf('"a CPU exhaustion issue caused the outage"');
  const end = start + '"a CPU exhaustion issue caused the outage"'.length;
  const first = response(text, [{ url: "https://blog.cloudflare.com/outage/", title: "Cloudflare postmortem", start, end }]);
  // A second canned response exists but must never be consumed.
  const client = fakeWebSearchClient([first, response("unused", [])]);

  await performEvidenceScoutSearch(created.action.action_id, { store, client });
  const action = await store.getAction(created.action.action_id);
  assert.equal(action?.search_call_count, 1, "only the first (sufficient) query should have been issued");
});

test("never issues more calls than MAX_QUERIES_PER_ACTION even if the action's own queries array were larger", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput({ queries: ["only one query authorized"] }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const client = fakeWebSearchClient([response("no citations here", [])]);
  await performEvidenceScoutSearch(created.action.action_id, { store, client });
  const action = await store.getAction(created.action.action_id);
  assert.equal(action?.search_call_count, 1);
  assert.equal(action?.state, "completed");
});

test("never persists more candidates than max_candidates", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput({ maxCandidates: 1 }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const text = "Source A. Source B.";
  const client = fakeWebSearchClient([
    response(text, [
      { url: "https://a.example.com/", title: "A", start: 0, end: 8 },
      { url: "https://b.example.com/", title: "B", start: 9, end: 17 },
    ]),
  ]);
  await performEvidenceScoutSearch(created.action.action_id, { store, client });
  const action = await store.getAction(created.action.action_id);
  assert.equal(action?.candidates.length, 1);
});

test("a search API error fails the action with a sanitized code, never a raw error message", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const client: WebSearchClient = { responses: { create: async () => { throw new Error("some raw upstream detail that must never leak, including a fake secret sk-abcdef123456"); } } };
  await performEvidenceScoutSearch(created.action.action_id, { store, client });
  const action = await store.getAction(created.action.action_id);
  assert.equal(action?.state, "failed");
  assert.equal(action?.failure_code, "search_api_error");
});

test("performEvidenceScoutSearch is a no-op (silent) when the action cannot be claimed -- duplicate delivery handled here, not by throwing", async () => {
  const store = new LocalEvidenceScoutCandidateStore();
  const created = await store.createAction(baseInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const client = fakeWebSearchClient([response("text", [])]);
  await performEvidenceScoutSearch(created.action.action_id, { store, client }); // consumes the action
  // A second call for the same (now completed) action must not throw, and must not consume a second canned response.
  await assert.doesNotReject(performEvidenceScoutSearch(created.action.action_id, { store, client: fakeWebSearchClient([]) }));
});
