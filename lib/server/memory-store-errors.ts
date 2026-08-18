/**
 * Extracted from memory-store.ts into its own module so
 * lib/server/cockroach-pool.ts (shared by memory-store.ts and
 * evidence-scout-store.ts) can throw it without creating a circular import.
 * memory-store.ts re-exports this; existing importers are unaffected.
 */
export class MemoryStoreUnavailableError extends Error {
  constructor(cause: unknown) { super("CockroachDB memory store is unavailable", { cause }); }
}
