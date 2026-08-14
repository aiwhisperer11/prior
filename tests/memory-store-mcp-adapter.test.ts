import assert from "node:assert/strict";
import test from "node:test";

import { McpMemoryStore, mcpMemoryStoreConfigFromEnv } from "../lib/server/memory-store-mcp-adapter";
import { MemoryStoreUnavailableError } from "../lib/server/memory-store";

test("McpMemoryStore fails loudly instead of pretending to succeed when unconfigured", async () => {
  const store = new McpMemoryStore(null);
  await assert.rejects(store.findPrecedents("domain", "case"), MemoryStoreUnavailableError);
  await assert.rejects(store.findSemanticPrecedents({ case_id: "c", case_title: "t", domain: "d", observed_outcome: "o", expected_behavior: "e", evidence: [] }, "c"), MemoryStoreUnavailableError);
  await assert.rejects(store.findLatestForCase("case"), MemoryStoreUnavailableError);
  await assert.rejects(
    store.save({ investigation: { meta: { case_id: "c" } } as never, isMock: true }),
    MemoryStoreUnavailableError,
  );
});

test("McpMemoryStore still fails loudly even when a config is present, since no tool-call mapping is implemented yet", async () => {
  const store = new McpMemoryStore({ endpoint: "https://cockroachlabs.cloud/mcp", credential: "fake" });
  await assert.rejects(store.findLatestForCase("case"), MemoryStoreUnavailableError);
});

test("mcpMemoryStoreConfigFromEnv returns null when MCP env vars are unset (true in every environment this project has run in)", () => {
  const originalEndpoint = process.env.MCP_SERVER_ENDPOINT;
  const originalCredential = process.env.MCP_SERVER_CREDENTIAL;
  delete process.env.MCP_SERVER_ENDPOINT;
  delete process.env.MCP_SERVER_CREDENTIAL;
  try {
    assert.equal(mcpMemoryStoreConfigFromEnv(), null);
  } finally {
    if (originalEndpoint !== undefined) process.env.MCP_SERVER_ENDPOINT = originalEndpoint;
    if (originalCredential !== undefined) process.env.MCP_SERVER_CREDENTIAL = originalCredential;
  }
});
