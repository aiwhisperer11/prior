import { Pool, type PoolConfig } from "pg";

import type { SherlockInvestigation } from "@/types/sherlock";

export interface PrecedentLead {
  caseId: string;
  caseTitle: string;
  domain: string;
  summary: string;
  isMock: boolean;
}

export interface StoredInvestigation {
  investigation: SherlockInvestigation;
  isMock: boolean;
}

export interface InvestigationMemoryStore {
  findPrecedents(domain: string, excludeCaseId: string): Promise<PrecedentLead[]>;
  save(record: StoredInvestigation): Promise<void>;
}

export class MemoryStoreUnavailableError extends Error {
  constructor(cause: unknown) { super("CockroachDB memory store is unavailable", { cause }); }
}

/** Ephemeral development fallback. Its records are explicitly mock data. */
export class LocalMemoryStore implements InvestigationMemoryStore {
  private readonly records: StoredInvestigation[] = [];

  async findPrecedents(domain: string, excludeCaseId: string): Promise<PrecedentLead[]> {
    return this.records
      .filter(({ investigation }) => investigation.meta.domain === domain && investigation.meta.case_id !== excludeCaseId)
      .slice(-3)
      .map(({ investigation }) => ({
        caseId: investigation.meta.case_id,
        caseTitle: investigation.meta.case_title,
        domain: investigation.meta.domain,
        summary: investigation.learning.summary,
        isMock: true,
      }));
  }

  async save(record: StoredInvestigation): Promise<void> { this.records.push({ ...record, isMock: true }); }
}

export class CockroachDBMemoryStore implements InvestigationMemoryStore {
  constructor(private readonly pool: Pool) {}

  async findPrecedents(domain: string, excludeCaseId: string): Promise<PrecedentLead[]> {
    try {
      const result = await this.pool.query<{ case_id: string; case_title: string; domain: string; summary: string }>(
        `SELECT case_id, case_title, domain, snapshot->'learning'->>'summary' AS summary
         FROM investigation_memory WHERE domain = $1 AND case_id <> $2
         ORDER BY created_at DESC LIMIT 3`, [domain, excludeCaseId],
      );
      return result.rows.map((row) => ({ caseId: row.case_id, caseTitle: row.case_title, domain: row.domain, summary: row.summary, isMock: false }));
    } catch (error) { throw new MemoryStoreUnavailableError(error); }
  }

  async save({ investigation, isMock }: StoredInvestigation): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO investigation_memory (case_id, case_title, domain, iteration, is_mock, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [investigation.meta.case_id, investigation.meta.case_title, investigation.meta.domain, investigation.meta.iteration, isMock, JSON.stringify(investigation)],
      );
    } catch (error) { throw new MemoryStoreUnavailableError(error); }
  }
}

type MemoryStoreGlobals = typeof globalThis & { __priorLocalStore?: LocalMemoryStore; __priorCockroachStore?: CockroachDBMemoryStore };
const stores = globalThis as MemoryStoreGlobals;

export function cockroachPoolOptions(databaseUrl: string): PoolConfig {
  try {
    const url = new URL(databaseUrl);
    if (!url.protocol.startsWith("postgres")) throw new Error("DATABASE_URL must use a PostgreSQL URL");
    if (url.searchParams.get("sslmode") !== "verify-full") throw new Error("DATABASE_URL must specify sslmode=verify-full");
    return { connectionString: databaseUrl, ssl: { rejectUnauthorized: true } };
  } catch (error) { throw new MemoryStoreUnavailableError(error); }
}

/** DATABASE_URL is read only on the server and never exposed to the client. */
export function getMemoryStore(): InvestigationMemoryStore {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return stores.__priorLocalStore ??= new LocalMemoryStore();
  if (!stores.__priorCockroachStore) stores.__priorCockroachStore = new CockroachDBMemoryStore(new Pool(cockroachPoolOptions(databaseUrl)));
  return stores.__priorCockroachStore;
}
