import { MemoryStoreUnavailableError, type LatestCaseSnapshot, type PrecedentLead, type SemanticMemoryStore, type StoredInvestigation } from "@/lib/server/memory-store";
import type { InvestigationRequest } from "@/types/sherlock";

/**
 * Target adapter for CockroachDB's Managed MCP Server
 * (https://cockroachlabs.cloud/mcp), per docs/cockroachdb-mcp-contract.md.
 *
 * This is real code implementing the real SemanticMemoryStore interface, not
 * a placeholder — but it is NOT wired into getMemoryStore() and every method
 * throws until constructed with a real endpoint + credential, which nothing
 * in this repository currently provides. It exists so the integration point
 * is concrete and testable, not so it can be mistaken for a working
 * connection.
 */
export interface McpMemoryStoreConfig {
  endpoint: string;
  /** Service-account API key or OAuth bearer token, per the contract doc. Never hardcode a real value here. */
  credential: string;
}

export class McpMemoryStore implements SemanticMemoryStore {
  constructor(private readonly config: McpMemoryStoreConfig | null) {}

  private unavailable(): never {
    throw new MemoryStoreUnavailableError(
      new Error(
        this.config
          ? `MCP Server call not implemented against ${this.config.endpoint} — the tool-call mapping in docs/cockroachdb-mcp-contract.md is a target design, not a verified integration.`
          : "MCP Server not configured in this environment.",
      ),
    );
  }

  async findPrecedents(_domain: string, _excludeCaseId: string): Promise<PrecedentLead[]> { return this.unavailable(); }
  async findSemanticPrecedents(_request: InvestigationRequest, _excludeCaseId: string, _limit?: number): Promise<PrecedentLead[]> { return this.unavailable(); }
  async findLatestForCase(_caseId: string): Promise<LatestCaseSnapshot | null> { return this.unavailable(); }
  async save(_record: StoredInvestigation): Promise<void> { return this.unavailable(); }
}

/** Reads MCP_SERVER_ENDPOINT / MCP_SERVER_CREDENTIAL if set; both are undefined in every environment this project has run in so far. */
export function mcpMemoryStoreConfigFromEnv(): McpMemoryStoreConfig | null {
  const endpoint = process.env.MCP_SERVER_ENDPOINT;
  const credential = process.env.MCP_SERVER_CREDENTIAL;
  if (!endpoint || !credential) return null;
  return { endpoint, credential };
}
