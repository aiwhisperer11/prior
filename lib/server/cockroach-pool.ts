import type { PoolConfig } from "pg";

import { MemoryStoreUnavailableError } from "@/lib/server/memory-store-errors";

/**
 * Shared by lib/server/memory-store.ts and lib/server/evidence-scout-store.ts.
 * Kept in its own module (rather than re-exported from memory-store.ts, which
 * evidence-scout-store.ts would otherwise need to import) specifically to
 * avoid a circular import between the two stores.
 */
export function cockroachPoolOptions(databaseUrl: string): PoolConfig {
  try {
    const url = new URL(databaseUrl);
    if (!url.protocol.startsWith("postgres")) throw new Error("DATABASE_URL must use a PostgreSQL URL");
    if (url.searchParams.get("sslmode") !== "verify-full") throw new Error("DATABASE_URL must specify sslmode=verify-full");
    return { connectionString: databaseUrl, ssl: { rejectUnauthorized: true } };
  } catch (error) { throw new MemoryStoreUnavailableError(error); }
}
