# S3 audit storage — target design

**STATUS: pending external integration.** No AWS account, credentials, or SDK
are configured in this environment. `lib/server/audit-storage.ts` provides a
real, working local adapter for development and a stub `S3AuditStorage` that
throws rather than pretending to upload. Nothing here should be read as "S3 is
wired up" — it's the design and the interface boundary the real integration
would sit behind. Per instruction, this uses S3 only (immutable object
storage), not Bedrock — the model stays OpenAI, unchanged.

## What S3 is for in this design

Three kinds of artifact this project produces are worth storing immutably,
separate from CockroachDB's structured `investigation_memory` rows:

1. **Original sources** — the raw fetched content of a case's evidence source
   (e.g. the Cloudflare/Google status-page text this session captured by hand
   via WebFetch). Storing the fetched bytes, not just a URL, means the
   fixture's provenance survives even if the source page changes or goes
   offline later.
2. **Evidence snapshots** — the exact `InvestigationRequest` JSON sent to the
   model for a given run, so a later audit can reproduce precisely what the
   model saw.
3. **Audit artifacts** — the raw model response text (`rawResponses` already
   returned by `runSherlockInvestigation` in `lib/server/sherlock-engine.ts`,
   currently written only to the gitignored `.sherlock/` directory by the
   eval scripts) and, where relevant, the OpenAI embedding request/response
   used for memory.

## Target shape

```ts
export interface AuditArtifact {
  key: string;        // object key (S3) or relative path (local dev)
  sha256: string;      // content hash, independent of storage backend
  sizeBytes: number;
  contentType: string;
}

export interface AuditStorage {
  putImmutable(key: string, content: string, contentType: string): Promise<AuditArtifact>;
  getImmutable(key: string): Promise<string | null>;
}
```

`LocalAuditStorage` (real, used today) writes to `.sherlock/audit/<key>`
(already `.gitignore`d — see "local live-evaluation artifacts" entry) and
computes a real sha256. `S3AuditStorage` (stub) throws `"AWS credentials not
configured"` for every call — it is not wired into `getMemoryStore()`'s save
path, and no code in this repository calls it today.

## What's deliberately NOT done yet

- **Not wired into `CockroachDBMemoryStore.save()`.** Adding
  `audit_artifact_key`/`audit_artifact_sha256` columns and populating them on
  every save is the natural next step, but doing that before there's a real
  S3 bucket to point at would mean shipping columns nobody can verify are
  correct — the same mistake this session avoided with the vector column by
  keeping it additive and clearly marked. When AWS access exists: add those
  two columns to a `003_` migration, extend `save()` to call
  `auditStorage.putImmutable(...)` for the raw model response before the
  `INSERT`, and store the returned key/hash.
- **No S3 SDK dependency added.** `@aws-sdk/client-s3` is not installed;
  adding it now with no credentials to test against would be exactly the kind
  of unverified dependency this project is trying not to accumulate.

## To actually verify this

1. Create an S3 bucket with object versioning and, ideally, Object Lock
   (write-once) enabled, matching the "immutable" requirement.
2. Add `@aws-sdk/client-s3`, implement `S3AuditStorage` for real, and set
   `AWS_REGION` / `AWS_S3_AUDIT_BUCKET` / standard AWS credential env vars.
3. Run `tests/integration/audit-storage-s3-live.test.ts` (to be added
   alongside the implementation, following the same excluded-from-`npm test`
   pattern as `tests/integration/memory-store-mcp-live.test.ts`) against the
   real bucket.
