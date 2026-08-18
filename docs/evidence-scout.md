# Governed Evidence Scout

PRIOR can search the web for a specific missing-evidence gap, but a search
result is never, by itself, evidence. This document describes the full
contract: state machine, persistence, API, and the guarantees that keep
"the model found a source" and "the case now has verified evidence" as two
separate, human-gated steps.

**This is not "chat with the internet."** Every search is scoped to one
named gap (a `missing_evidence` item, or a user-typed intent), authorized
explicitly by a human before any call fires, and capped hard (≤2 queries,
≤5 candidates per action). Nothing a search returns can reach
`case.evidence` without an explicit accept decision on that exact candidate.

## State machine

```
missing_evidence -> search_plan -> source_candidate -> accepted_evidence | rejected_candidate -> reinvestigation

action:    authorized -> searching -> completed | failed
candidate: pending -> accepted | rejected   (terminal, idempotent, never flips)
```

- `authorized`: created by `POST /api/investigate/evidence-scout/search`, requires an `Idempotency-Key` header.
- `searching`: claimed by exactly one worker (see "Lease/claim" below) -- a duplicate SQS delivery or a retry cannot double-claim.
- `completed` / `failed`: terminal. `failed` carries a sanitized `failure_code` (never a raw error message or stack -- see the enum in `db/migrations/004_evidence_scout.sql`).
- `pending -> accepted|rejected`: a `source_candidate` is never an `EvidenceItem`. Only `accepted`, and only if its `verification_status` is `citation_supported` or `verified_as_published` (**never `source_located`**), is eligible to become evidence -- and even then, only once a follow-up actually references it.

## Verification ladder

| status | means | can become evidence? |
|---|---|---|
| `source_located` | a URL/publisher was found, nothing more | never |
| `citation_supported` | a claim summary + fragment accompany the citation | yes |
| `verified_as_published` | a literal, quote-delimited excerpt (`cited_text`) was found | yes |

A `url_citation` alone is never sufficient for `verified_as_published` -- it
only proves the search model attributed a span of *its own* generated text
to a URL, not that the span is verbatim source text. `cited_text` is
populated only when the model's own output wraps the cited span in
quotation marks (see `lib/server/evidence-scout-search.ts`); this is a
structural signal, never a semantic judgment about accuracy.

## Provenance -- server-owned, never inferred by the model

Accepting an eligible candidate produces an `EvidenceProvenance` object,
attached to a new, server-numbered `EvidenceItem.provenance`
(`lib/investigation.schema.json`, required + nullable, same pattern as
`prime_suspect`/`killed_by`). Every field is resolved **server-side** from
the durable `evidence_scout_candidate` row -- a follow-up request only ever
carries `accepted_candidate_ids: string[]` (opaque UUID references), never
provenance content. The investigator model always echoes `provenance: null`
for every evidence item (its own reasoning never touches this field); the
Case Envelope (`applyCanonicalCaseEnvelope`) replaces `case.evidence`
wholesale with the server's own copy regardless of what the model returns,
so nothing the model invents here can ever survive.

**Legacy compatibility**: an investigation persisted before this field
existed literally lacks the `provenance` key on its evidence items (not
`null` -- absent). `lib/server/evidence-scout-legacy-schema.ts` compiles a
second, deliberately relaxed AJV validator (the same schema, with
`provenance` removed from that one `required` array) used **only** to
accept an incoming `previous_snapshot` on a follow-up request -- never to
validate a fresh model response, and never what gates the final `ok: true`
return value in `runSherlockInvestigation`.

## Persistence (migration 004)

Two additive CockroachDB tables, `evidence_scout_action` and
`evidence_scout_candidate` (`db/migrations/004_evidence_scout.sql`, **not
yet applied to any cluster** -- apply manually, like every other migration
in `db/migrations/`). Rejected candidates are persisted too, alongside
accepted ones; nothing durable is created for a search the user never
authorizes.

**Snapshot insert + candidate link, one transaction.** When a follow-up
incorporates `accepted_candidate_ids`, `CockroachDBMemoryStore.saveSnapshotWithEvidenceLinks`
(`lib/server/memory-store.ts`) inserts the new `investigation_memory` row
*and* updates every linked `evidence_scout_candidate` row inside one
`BEGIN`/`COMMIT`, each link guarded by `WHERE state = 'accepted' AND
evidence_id IS NULL`. If any candidate was already spent by a racing
follow-up, the whole transaction rolls back -- including the snapshot
insert. A candidate can be spent exactly once; this guarded, transactional
UPDATE is what actually enforces that, not a static constraint alone.

## Dispatch: SQS + Lambda in production, synchronous local execution in dev/test

```
POST /search -> store.createAction() -> executor.invoke(actionId) [awaited] -> 202 {action_id}
```

The route **always awaits** `executor.invoke()`. For the `local` executor
(dev/test default) this runs the entire search synchronously in-process
before the response is sent -- correct and deterministic for tests, which
never rely on fire-and-forget or sleep-based polling. For the `sqs`
executor (production, `EVIDENCE_SCOUT_EXECUTOR=sqs`), awaiting only waits
for the `SendMessageCommand` acknowledgment (fast); the Lambda-driven
search itself happens asynchronously afterward, so the 202+poll contract
still holds. Production refuses the `local` executor outright, even if left
unset -- see `getEvidenceScoutExecutor` in `lib/server/evidence-scout-executor.ts`.

A dispatch failure (the SQS send itself fails) is recoverable:
`markDispatchFailed` records `failure_code='dispatch_failed'` with no lease,
and retrying the same `Idempotency-Key` revives that row to `authorized`
and re-sends it instead of spending budget twice.

**Explicit limitation, still pending**: there is still a narrow
crash-after-DB-before-SQS window. If the process dies after
`createAction()` commits but before `executor.invoke()` sends to SQS (or
before the catch path can mark `dispatch_failed`), the row can remain
`authorized` with no queue message. That is **not** automatically repaired
in this slice; recovery currently depends on the client retrying the same
`Idempotency-Key`, which reuses and re-dispatches the existing action. An
outbox/EventBridge-style dispatcher would be required to close this window
without client participation, but it is not implemented here.

### Live AWS verification — 2026-08-18

- State: `completed`.
- `search_call_count`: `1`.
- Candidates: `4`.
- Verified path: SQS → Lambda → OpenAI `web_search` → CockroachDB.
- Per-action limits: maximum 2 searches and 5 candidates.

### Lease / claim / redelivery

SQS delivers at-least-once and may invoke the Lambda more than once for the
same action (duplicate delivery), or redeliver after `VisibilityTimeout` if
a prior invocation crashed mid-flight. `claimAction`'s guarded UPDATE
(`lib/server/evidence-scout-store.ts`) is what actually resolves both:

```sql
WHERE (state = 'authorized' OR (state = 'searching' AND leased_until < now()))
  AND attempt_count < 3
```

Numbers are deliberately layered (`infra/evidence-scout-lambda/template.yaml`,
`CLAIM_LEASE_SECONDS`/`MAX_ATTEMPTS` in `evidence-scout-store.ts`): Lambda
`Timeout` 90s < DB lease 120s < SQS `VisibilityTimeout` 540s (6x the Lambda
timeout, AWS's documented sizing guidance). The SQS event source mapping
is explicitly enabled and also caps `MaximumConcurrency` at 3, so at most
three queue deliveries can be processed concurrently without reserving
account-level Lambda capacity. The SAM esbuild output extension is forced
to `.mjs`, matching the Lambda's ESM bootstrap artifact name at build
time.
`GET /actions/:actionId`
opportunistically repairs an expired, attempt-exhausted lease to `failed`
on read -- no cron required.

## Limits (fail-closed)

- Search disabled by default (`ENABLE_EVIDENCE_SCOUT_SEARCH`, unset =
  disabled). `npm test` never sets it, and every test that exercises the
  search logic injects an explicit fake client -- `getOpenAIClient()` is
  never reached from the test suite.
- ≤2 queries, ≤5 candidates per action (`lib/server/evidence-scout-policy.ts`).
- Daily global action budget (`EVIDENCE_SCOUT_DAILY_ACTION_LIMIT`, default
  20), checked and incremented inside one serializable CockroachDB
  transaction (`CockroachDBEvidenceScoutCandidateStore.createAction`) -- a
  genuine conflict surfaces as a retryable failure, never a silent race.
- Optional case allowlist (`EVIDENCE_SCOUT_CASE_ALLOWLIST`, comma-separated
  case_ids; unset = no restriction).
- Stops issuing further authorized queries once an `official_primary`,
  `verified_as_published` candidate is found.

## Security

- `source_url` scheme is constrained to `http(s)://` at the database level (`CHECK (source_url ~ '^https?://')`).
- No page content is ever fetched or executed by this feature; `fragment`/`cited_text` are bounded to 2000 characters each and come only from the search model's own output, never a separate page fetch.
- No secrets, credentials, or signed URLs are ever persisted -- there is no column for them.
- `failure_code` is a closed, sanitized enum; the real exception, if any, goes to server-side logs only.

## What was retired

The prior `gbp-rub-june-2023` mock (`lib/server/evidence-scout.ts`,
`components/EvidenceScoutPanel.tsx`, its dedicated "Investigate GBP/RUB
fixture" button) is gone -- it had no search, no acceptance gate, and
unconditionally fed retrieved data into the investigator prompt via
`retrieved_evidence_context`, which is also removed
(`lib/sherlock-prompt.ts`, `lib/server/investigation-flow.ts`). The
`examples/gbp-rub-june-2023.json` fixture itself remains, inert, as an
ordinary example investigation input, disconnected from any Scout code
path.
