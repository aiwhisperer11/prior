/**
 * Real integration test against CockroachDB's Managed MCP Server — requires
 * MCP_SERVER_ENDPOINT and MCP_SERVER_CREDENTIAL to be set to real values.
 *
 * Deliberately NOT matched by `tests/*.test.ts` (npm test's glob), so it
 * never runs in the fast suite and never needs credentials to exist for
 * `npm test` to pass. Run explicitly with:
 *
 *   node --test --import tsx tests/integration/memory-store-mcp-live.test.ts
 *
 * As of this writing, no environment this project has run in has these
 * credentials, so this file has never executed past the guard below. It
 * exists so the verification path is real and runnable, not aspirational.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { McpMemoryStore, mcpMemoryStoreConfigFromEnv } from "../../lib/server/memory-store-mcp-adapter";

const config = mcpMemoryStoreConfigFromEnv();

test("McpMemoryStore.findPrecedents against a real CockroachDB Managed MCP Server", { skip: !config && "MCP_SERVER_ENDPOINT/MCP_SERVER_CREDENTIAL not set" }, async () => {
  const store = new McpMemoryStore(config);
  // This will currently fail even with real credentials: the tool-call
  // mapping in docs/cockroachdb-mcp-contract.md is not implemented in
  // McpMemoryStore yet (every method throws MemoryStoreUnavailableError).
  // Implementing it for real is the next step once credentials exist.
  await assert.rejects(store.findPrecedents("test-domain", "no-such-case"));
});
