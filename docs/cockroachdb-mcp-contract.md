# CockroachDB Managed MCP Server — target integration contract

**STATUS: Interactive read-only verification: VERIFIED 2026-08-14. Runtime
application integration: PENDING.** `lib/server/memory-store-mcp-adapter.ts`
implements the `SemanticMemoryStore` interface against this contract but fails
loudly (throws "MCP Server not configured in this environment") rather than
pretending to succeed. Nothing here should be read as "the MCP integration
works" — it's the adapter this project would need to finish wiring given real
access.

## Source

Facts below are drawn directly from Cockroach Labs' own announcement,
[Managed MCP Server for AI Agents](https://www.cockroachlabs.com/blog/cockroachdb-ai-agents-managed-mcp-server/)
(fetched 2026-08-12). The article does not enumerate a full tool catalog or show
a sample request/response payload — where it doesn't specify something, this
document says so rather than inventing it.

Interactive read-only verification was performed on `2026-08-14` against the
`prior-dev` cluster using read-only MCP access plus an independent direct-`pg`
cross-check. See `docs/verification/cockroachdb-mcp-2026-08-14.md` for the
sanitized artifact. Runtime application integration is still pending.

## What's real, per Cockroach Labs

- Endpoint: `https://cockroachlabs.cloud/mcp`, HTTP transport (SSE excluded),
  JSON-RPC requests/responses over HTTPS.
- Auth: OAuth 2.1 (Authorization Code + PKCE) for interactive use, or a service
  account API key for autonomous/CI environments. Config is generated from the
  Cloud Console and pasted into the MCP client's config file — the exact
  snippet format is not published.
- Read-only by default; write access requires explicit OAuth consent scope.
  Destructive operations (`DROP`, `TRUNCATE`) are unsupported even with write
  consent.
- Named tools the article confirms exist: `list_databases`, `select_query`,
  `get_table_schema` (read-only); `create_database`, `create_table`,
  `insert_rows` (write, consent-gated). No vector-search-specific tool is
  mentioned anywhere in Cockroach Labs' own material.

## Target mapping: `SemanticMemoryStore` → MCP tool calls

This is this project's proposed mapping, not a documented CockroachDB API —
it is the shape `lib/server/memory-store-mcp-adapter.ts` would need to speak if
this MCP server exposed (or were extended to expose) the same operations
`CockroachDBMemoryStore` runs directly today via `pg`.

| `SemanticMemoryStore` method | MCP tool call (target) | Notes |
|---|---|---|
| `findPrecedents(domain, excludeCaseId)` | `select_query` with the exact SQL from `memory-store.ts`'s `findPrecedents` | Read-only; works with today's published tool set. |
| `findSemanticPrecedents(request, excludeCaseId, limit)` | `select_query` with `ORDER BY embedding <-> $1 LIMIT $2` | Read-only, but **assumes** `select_query` accepts parameterized vector-typed values — unconfirmed; the source article never mentions vector search. |
| `findLatestForCase(caseId)` | `select_query` with `WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1` | Read-only, same caveat as above for the `embedding` column type round-tripping through JSON-RPC. |
| `save(record)` | `insert_rows` against `investigation_memory` | Requires write consent scope. The article gives no evidence `insert_rows` supports `ON CONFLICT` semantics — the idempotency guarantee `CockroachDBMemoryStore.save()` provides via `INSERT ... ON CONFLICT (source_id) DO NOTHING` is **not confirmed reproducible** through this tool and would need verification against a real cluster. |

## Adapter behavior

`lib/server/memory-store-mcp-adapter.ts` exports `McpMemoryStore`, structurally
implementing `SemanticMemoryStore`. Every method throws
`MemoryStoreUnavailableError("MCP Server not configured in this environment")`
unless constructed with a real endpoint + credential, which nothing in this
repo currently provides. It exists so the integration point is real code with a
real interface, not a placeholder comment — but it is explicitly **not** wired
into `getMemoryStore()`, so it has zero effect on the running application today.

## To actually verify this

1. Provision a CockroachDB Cloud cluster, enable the Managed MCP Server from
   the Cloud Console, generate a service-account credential.
2. Confirm with Cockroach Labs support/docs whether `select_query` and
   `insert_rows` round-trip `VECTOR` columns and support `ON CONFLICT` —
   neither is documented publicly as of the source date above.
3. Point `McpMemoryStore` at the real endpoint and run
   `tests/memory-store-mcp-adapter.integration.test.ts` (not part of `npm test`
   — it requires real credentials and is intentionally excluded from the fast
   suite) against it.
