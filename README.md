# Sherlock

> **Most AI gives you the most plausible answer. Sherlock earns the answer by trying to prove itself wrong.**

**Demo video**  
https://www.youtube.com/watch?v=xkpN5Y9lYGg

**Live demo**  
https://sherlock-engine.vercel.app/

**Repository**  
https://github.com/aiwhisperer11/sherlock-engine

---

## Why I built Sherlock

I started this project with a simple observation.

Large language models are very good at producing plausible explanations. They are much less disciplined at looking for reasons why those explanations might be wrong.

In other words, they suffer from the same confirmation bias that affects human investigations.

Once a model finds a coherent explanation, it naturally tends to reinforce it instead of actively searching for competing ones.

That is useful if your goal is to answer questions.

It is dangerous if your goal is to investigate.

Sherlock is an experiment built around a different question:

> **What happens if we force an LLM to think like an investigator instead of an assistant?**

Not by asking it to "reason better", but by changing the investigation itself.

Instead of producing the first plausible explanation, Sherlock forces the model to work under a different set of constraints:

- Every conclusion must compete with alternative explanations.
- Every hypothesis must explain what evidence supports it.
- Every hypothesis must explain what evidence contradicts it.
- Every hypothesis must declare exactly what observation would prove it wrong.
- Every new piece of evidence must update the existing investigation instead of replacing it.

The objective is not to make the model produce a better answer.

The objective is to make it **earn** the answer.

---

## What Sherlock does

Sherlock receives four things:

- **What happened**
- **What should have happened**
- **The available evidence**
- **Optionally, the investigator's own hypotheses**

Instead of returning a single explanation, it builds a structured investigation.

The investigation includes:

- An **Expectation Matrix** that separates expected and unexpected observations, paying special attention to expected events that never occurred.
- **Competing hypotheses** that evolve as new evidence is introduced.
- A **Hypothesis Graveyard** that preserves rejected explanations together with the exact conditions that would make them plausible again.
- **Missing evidence**, ranked by its ability to reduce uncertainty.
- The **single next test** with the highest discriminating power between the leading hypotheses.

Every investigation can continue as new evidence appears.

Reasoning is no longer a one-shot answer.

It becomes an evolving investigation.
## Current status

Current implementation includes:

- The complete contract is [`lib/investigation.schema.json`](../lib/investigation.schema.json).
- [`lib/wire-schema.ts`](../lib/wire-schema.ts) derives the strict OpenAI wire
  schema without mutating the canonical contract.
- The API validates every model response with AJV and retries one invalid
  response before returning a 502 with validation details.
- The browser supports a baseline investigation and evidence-driven follow-up
  iterations. It keeps client-only, append-only snapshots and renders the
  latest one plus a diff of the two latest snapshots.
- The UI can replay Case B baseline and iteration 2 offline, without calling
  the API.

There is no database, authentication, persistence, routing, or cross-case
memory. Snapshots exist only for the current browser session.

## How this was built: Codex + GPT-5.6

### Codex: the builder

Sherlock was built end-to-end in disciplined Codex sessions, each driven by a
written brief with explicit acceptance criteria and a session rule: *one
finished block beats three half-started ones — unfinished work is finished or
reverted, and the repo stays green.*

- **Block 1 — Contract:** collapsed a two-schema split into a single canonical
  contract ([`lib/investigation.schema.json`](../lib/investigation.schema.json))
  with a programmatically derived OpenAI wire schema and mirrored types.
- **Block 2B — Reasoning:** wired the falsification prompt to the engine and
  added a semantic evaluation harness.
- **Block 3 — UI:** built the full investigation view, consuming canonical
  field names with no response remapping and schema-backed client validation.
- **Block 4 — Iteration loop:** added evidence-driven re-investigation with
  server-continued evidence IDs and a client-computed learning diff.

The briefs Codex executed are preserved in [`docs/`](.) as a record of the
method. Codex /feedback session ID for the main build: 019f7a1d-9a54-7df3-a3ce-09c140b083f7.

### GPT-5.6: the investigator

The reasoning core runs on **`gpt-5.6-terra`** (GPT-5.6 family, Terra tier)
using **Structured Outputs in strict mode**. The model must return a JSON
snapshot conforming to the canonical investigation schema, and every response
is re-validated server-side with AJV before it reaches the client.

GPT-5.6 is not used as a chat wrapper: the system prompt is a versioned
reasoning specification ([`docs/investigation-engine.md`](investigation-engine.md))
with eleven numbered investigation principles (P1–P11), an output contract,
and iteration rules. Every hypothesis must declare what would refute it; every
absence must be anchored to declared expected behavior and observable
instrumentation; every score ships with its explanation.

### Prompt evaluation

The investigation prompt (v3.0) was evaluated using the Block 2B semantic
evaluation suite.

During the first live evaluation, one assertion failed:

- `next_test structurally discriminates the prime suspect`

Inspection of the generated investigation artifact showed that the model had
already produced a valid discriminating test between competing hypotheses (H3
and H4). The failure was traced to a false negative in the evaluation logic,
not to the prompt itself.

The temporary prompt experiment was discarded, the original v3.0 prompt was
restored unchanged, and the evaluator was rewritten to verify structural
discrimination rather than relying on prose heuristics.

Regression tests were added for the evaluator, and the subsequent live
evaluation passed all assertions (11/11).

This project therefore treats evaluation artifacts as the source of truth and
prefers correcting the measurement instrument before modifying prompts.

## Setup

Create a local, ignored environment file at the repository root:

```text
OPENAI_API_KEY="your-key"
```

Use `.env.local`; it is covered by `.gitignore`. Do not commit it or paste its
contents into issues, logs, or chat.

```bash
npm run dev
```

Open `http://localhost:3000`.

## Using the app

1. Select **Load example** to populate the Case B baseline form, then select
   **Investigate** to call `POST /api/investigate`.
2. On a rendered result, select **Add example follow-up evidence**, then
   **Re-investigate**. The server validates the prior snapshot, assigns the
   next evidence ID (`E5` for Case B), and creates iteration 2.
3. The latest snapshot is rendered. The Learning Diff shows confidence changes,
   status transitions, entries into the Hypothesis Graveyard, and the model's
   learning summary. Evidence introduced in the latest iteration is marked in
   the case evidence list.
4. For a no-network demo, use **View initial investigation** or **View updated
   investigation** under **Example case**.

## Investigation API

`POST /api/investigate` supports two request modes.

### Baseline

```json
{
  "case_id": "case-b-checkout",
  "case_title": "Checkout 500 errors, 23:10-23:40",
  "domain": "IT incident",
  "observed_outcome": "...",
  "expected_behavior": "...",
  "evidence": [{ "id": "E1", "label": "...", "content": "..." }],
  "user_hypotheses": ["..."]
}
```

`observed_outcome`, `expected_behavior`, and at least one complete evidence
item are required.

### Follow-up iteration

```json
{
  "previous_snapshot": { "...": "full SherlockInvestigation" },
  "new_evidence": [{ "label": "Certificate audit", "content": "..." }]
}
```

The server validates `previous_snapshot` against the canonical schema, carries
the existing case data forward, appends server-numbered evidence, and sets
`meta.iteration` to the previous iteration plus one. The model receives the
full previous snapshot and the new-evidence block described in the frozen
prompt specification.

## Architecture

```text
app/api/investigate/route.ts       HTTP adapter and error responses
lib/server/sherlock-engine.ts      Request preparation, OpenAI call, AJV validation
lib/investigation.schema.json      Sole canonical investigation contract
lib/wire-schema.ts                 Derived OpenAI Structured Outputs schema
docs/investigation-engine.md       Frozen v3 reasoning specification and prompt source
components/                        Baseline form, follow-up form, result view, learning diff
examples/                          Case B inputs and validated offline snapshots
```

[`types/sherlock.ts`](../types/sherlock.ts) mirrors the canonical response
shape. UI code consumes those field names directly; it does not flatten or
remap model responses. [`lib/investigation-validation.ts`](../lib/investigation-validation.ts)
validates untrusted API and fixture payloads client-side before they enter
snapshot state.

`lib/sherlock-schema.json` remains in the repository as a legacy artifact but
is not part of the runtime request or response path.

## Fixtures and evaluation

- [`examples/case-b.json`](../examples/case-b.json): baseline request fixture.
- [`examples/case-b-baseline-snapshot.json`](../examples/case-b-baseline-snapshot.json):
  validated baseline snapshot for offline rendering.
- [`examples/case-b-evidence-e5.json`](../examples/case-b-evidence-e5.json):
  follow-up certificate audit.
- [`examples/case-b-iteration2-snapshot.json`](../examples/case-b-iteration2-snapshot.json):
  validated live iteration-2 snapshot for offline replay.
- [`docs/evaluation.md`](evaluation.md): Block 2B evaluation notes.

Run the checks:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

With a local API key configured, run the live baseline evaluator:

```bash
npm run eval:case-b
```

The evaluator writes raw model output to the ignored
`.sherlock/case-b-live-result.json` and exits non-zero when a semantic
assertion fails.
