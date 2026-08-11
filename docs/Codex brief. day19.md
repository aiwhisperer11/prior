# Codex Session Brief — Day 19: "Single-shot real"

## Session objective (definition of done)

`POST /api/investigate`, given the Case B input below, returns a JSON snapshot that:
1. Validates against `lib/investigation.schema.json` (ajv, draft 2020-12, strict).
2. Marks the deploy hypothesis as `weakened` (not leading).
3. Places the missing TLS renewal log line in the `expected_absent` quadrant.
4. Produces a `next_test` that discriminates between the deploy and TLS hypotheses.
And the result renders in the browser (ugly is fine).

If (2)-(4) fail with valid JSON, the problem is the prompt, not the code: iterate on `lib/sherlock-prompt.ts`, not on components.

## Architectural decision to implement first

**Collapse the two-schema split.** `lib/investigation.schema.json` is the single
source of truth. Delete `lib/sherlock-schema.json` as a hand-maintained file;
instead derive the wire schema sent to OpenAI programmatically at module load:

- Strip JSON Schema keywords unsupported by OpenAI structured outputs strict
  mode (e.g. `minimum`, `maximum`, `minItems`) — those constraints are enforced
  server-side by ajv on the response instead.
- Keep `additionalProperties: false` and full `required` lists (strict mode needs them).

`types/sherlock.ts` must be regenerated from the same source (json-schema-to-typescript
or hand-written to match; if hand-written, add a comment header pointing to the schema).

## Blocks, in order

### Block 1 — Contract
- [ ] Wire-schema derivation utility (`lib/wire-schema.ts` or similar).
- [ ] Regenerate `types/sherlock.ts` to mirror `investigation.schema.json` exactly
      (statuses: `active | weakened | rejected | revived`; nullable `killed_by`,
      `resurrection_condition`, `previous_confidence`, `previous_status`).
- [ ] Add ajv + a conformance test: the Case B expected-output fixture validates.
- [ ] Acceptance: `npm test` green with the fixture; `tsc --noEmit` clean.

### Block 2 — Engine
- [ ] Rewrite `app/api/investigate/route.ts`:
      input `{ case_id, case_title, domain, observed_outcome, expected_behavior,
      evidence: [{id, label, content}], user_hypotheses?: string[] }`.
- [ ] `lib/sherlock-prompt.ts`: system prompt encoding the falsification rules
      (will be provided separately — do not improvise it; placeholder OK to unblock).
- [ ] Call OpenAI with `response_format: { type: "json_schema", strict: true }`
      using the derived wire schema. **Model: gpt-5.6** (contest requirement —
      make the model id a named constant, not buried in the call).
- [ ] Validate the response with ajv against the full schema BEFORE returning;
      on validation failure, retry once, then return 502 with the ajv errors.
- [ ] Acceptance: Case B input → response meets session objective points 1–4.

### Block 3 — Minimal UI (only if Blocks 1–2 done)
- [ ] Input form: observed outcome, expected behavior, dynamic evidence list,
      optional initial hypotheses. "Load example" button that fills Case B.
- [ ] Render: 4-quadrant ExpectationMatrix (highlight `expected_absent`),
      hypothesis list with status badge + confidence, PrimeSuspectCard,
      NextTestCard with outcome map, MirrorQuestion footer.
- [ ] No styling effort. Structure only.

### Housekeeping (5 min, do not skip)
- [ ] `.env.local.example` with `OPENAI_API_KEY=`.
- [ ] `examples/case-b.json` (the input below) — used by the test, the demo
      button, and the judges. Triple purpose.

## Case B input fixture (`examples/case-b.json`)

```json
{
  "case_id": "case-b-checkout",
  "case_title": "Checkout 500 errors, 23:10-23:40",
  "domain": "IT incident",
  "observed_outcome": "E-commerce checkout returned a spike of HTTP 500 errors from 23:10 to 23:40. The on-call team blamed the 23:00 deploy and rolled it back at 23:25, but errors continued until 23:40 and then stopped on their own.",
  "expected_behavior": "Deploys either cause immediate errors or none; a rollback removes any deploy-caused failure within minutes. The nightly TLS certificate renewal cron for the payment service runs at 23:05 and always writes a log line confirming renewal. Payment API calls succeed with valid certificates. Database latency stays under 50ms at that traffic level.",
  "evidence": [
    { "id": "E1", "label": "Deploy log", "content": "Deploy completed 23:00. Rollback completed 23:25. Error rate unchanged by rollback; errors ceased 23:40." },
    { "id": "E2", "label": "DB latency metrics", "content": "Database latency stable at 22-35ms throughout the incident window." },
    { "id": "E3", "label": "Payment provider log", "content": "Payment API rejecting connections 23:10-23:40 with TLS handshake failures. Connections resume 23:40." },
    { "id": "E4", "label": "Cron scheduler log", "content": "Entries present for 22:00 and 00:00 jobs. No entry for the 23:05 TLS renewal job tonight. Retry sweep runs at 23:38." }
  ],
  "user_hypotheses": [
    "The 23:00 deploy broke the checkout flow",
    "Database overload under evening traffic"
  ]
}
```

## Expected investigative outcome (for the conformance test, not shown to the model)

- Deploy hypothesis: `weakened` — temporal correlation (E1) but contradicted by
  rollback failure (E1) and TLS handshake evidence (E3).
- DB overload hypothesis: `rejected` — killed by E2; resurrection_condition
  should reference latency data contradicting E2.
- TLS renewal silent failure (engine-generated): leading `active` hypothesis —
  supported by E3 + the E4 absence; the 23:38 retry sweep explains the 23:40
  recovery. Expected in `expected_absent`: the missing 23:05 renewal log line.
- `next_test`: certificate validity timestamps for the payment service during
  the window (or equivalent), discriminating deploy vs TLS hypotheses.

## Out of scope today (do not build)

Iteration loop / learning diffs beyond `is_baseline: true` · Case A · visual design ·
deployment · video assets.

## Session discipline rule

If a block cannot be completed within the allocated session: **stop**. Leave the
repository green (`next build`, `tsc --noEmit` and tests passing), document the
current state and the exact remaining work in the README's "Current implementation
status" section, and **do not start the next block**. With a 3-day deadline, one
finished block beats three half-started ones. A partially implemented block must
be either finished or reverted — never left half-wired into the main flow.