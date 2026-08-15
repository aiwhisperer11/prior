# S3 audit storage

**STATUS: implemented, unit-tested against injectable fakes, not yet verified
against a real bucket.** No live AWS call has been made from this codebase.
`lib/server/audit-storage.ts` provides a real, working local adapter
(`LocalAuditStorage`) and a real S3 adapter (`S3AuditStorage`) built on
`@aws-sdk/client-s3`, both implementing the same `AuditStorage` interface.
Every test in `npm test` uses an injectable fake client
(`S3ClientLike`/`AuditStorage`) — none of them touch a real bucket. Per
instruction, this uses S3 only for write-once artifact storage, not Bedrock —
the model stays OpenAI, unchanged. (See "What's deliberately NOT done yet"
below for exactly what "write-once" does and does not guarantee here.)

## What S3 is for in this design

One artifact per persisted investigation snapshot: the canonical **audit
envelope** (`lib/server/audit-artifact.ts`) — everything needed to
reconstruct the decision a snapshot represents, separate from CockroachDB's
structured `investigation_memory` row. See "Canonical artifact" below for the
exact shape.

## Architecture

```text
request
  -> model (lib/server/sherlock-engine.ts: runSherlockInvestigation)
  -> Case Envelope canonicalization + semantic integrity gate
     (applyCanonicalCaseEnvelope / semanticIntegrityErrorsFor)
  -> lib/server/investigation-flow.ts: runInvestigationFlow
       -> CockroachDBMemoryStore.save() (lib/server/memory-store.ts):
            1. build the audit artifact envelope + sha256 (app-side, no I/O)
            2. write + independently verify it via AuditStorage.putImmutable
            3. INSERT the CockroachDB snapshot row, including the artifact's
               key + sha256
  -> API response (app/api/investigate/route.ts): safe lineage only
  -> Audit & lineage panel (components/InvestigationPresentation.tsx)
```

## Ordering and partial-failure semantics (load-bearing, not incidental)

There is no distributed transaction across S3 and CockroachDB, so the order
above is deliberate:

- **If step 2 (S3 write/verify) fails:** nothing is persisted to CockroachDB
  and nothing is reported as a completed investigation. `save()` throws
  `AuditStorageUnavailableError` (storage unreachable/misconfigured) or
  `AuditIntegrityError` (a key already holds different content, or what was
  written doesn't match what was read back). There is no fallback to local
  storage — `AUDIT_STORAGE_BACKEND` is resolved once and never silently
  substituted.
- **If step 3 (CockroachDB INSERT) fails after step 2 already succeeded:**
  the artifact is **not deleted** — `AuditStorage` exposes no delete
  capability at all, by design, and the IAM policy this project verified has
  no `DeleteObject` permission either. `save()` throws
  `OrphanedAuditArtifactError`, carrying the artifact's key and sha256, so a
  human can reconcile it. This is intentional: an orphaned S3 object is
  auditable and reconcilable later; a CockroachDB row that claims an artifact
  exists when it does not would be strictly worse.

`app/api/investigate/route.ts` maps each of these to a distinct HTTP error
(503 for unavailable storage, 409 for an integrity conflict, 500 with the
artifact key/hash for an orphan) — never conflated with "OpenAI request
failed".

## Canonical artifact (`lib/server/audit-artifact.ts`)

`AuditArtifactEnvelope` (schema version `1.0.0`) contains exactly:
`schema_version`, `case_id`, `investigation_id`, `snapshot_id`,
`parent_snapshot_id`, `iteration`, `model_version`, `prompt_version`,
`case_envelope` (`{meta, case}` — the server-owned identity boundary from
`applyCanonicalCaseEnvelope`), `retrieved_memory` (the classified
related/longitudinal/suspected-duplicate/unclassified memory for this run),
`canonical_investigation` (the full validated `SherlockInvestigation`), and
`created_at` (stamped server-side at build time — never accepted from a
caller). It never carries env vars, credentials, headers, `DATABASE_URL` or
any connection string, AWS account/bucket identifiers, bucket policy, or raw
embedding vectors — see `tests/audit-artifact.test.ts` for the regression
that checks this.

Serialization is deterministic (`canonicalize()` from
`lib/server/v2-snapshot-store.ts`, already used for `computeSourceId` — reused
rather than reinvented): identical envelopes always produce identical bytes
and therefore identical sha256, regardless of property insertion order.

## Key and idempotency

`investigations/<case-id>/<investigation-id>/<snapshot-id>.json`. Every
segment is sanitized independently (`sanitizeArtifactKeySegment`): stripped to
`[A-Za-z0-9._-]`, traversal sequences collapsed, leading/trailing dots and
dashes trimmed, and a segment that sanitizes to nothing is rejected outright
rather than silently producing a malformed key. A case_id containing `/` or
`..` cannot inject extra path segments.

`snapshot_id` (and `investigation_id`, on a fresh case) are generated
**application-side**, before any I/O — not left to CockroachDB's
`id UUID PRIMARY KEY DEFAULT gen_random_uuid()`. This is required by the
ordering above: the artifact key must be known before the S3 write, and the S3
write must happen before the CockroachDB row can exist.

Write-once semantics use a conditional `PutObject` (`IfNoneMatch: "*"`):

- key absent -> writes, then independently verifies.
- key present with identical content (same sha256) -> idempotent success —
  the retried write is treated as a no-op, never a duplicate or an error.
- key present with different content -> `AuditIntegrityError`; never
  overwritten.

The sha256 is also stored as S3 object `Metadata`, so it round-trips even if
this codebase's own hashing logic ever changes later.

**Known minor inefficiency, intentionally not fixed here:** because
`snapshot_id` is freshly randomized on every `save()` call before the
`source_id`-based idempotency check runs, a retried save with byte-identical
investigation content writes a *second*, distinct, orphaned-but-harmless S3
artifact under a new key before CockroachDB's `ON CONFLICT (source_id) ...
DO NOTHING` skips the row. No data is lost or corrupted — just a wasted write.
Avoiding it would require an extra existence check before building the
artifact at all; left as a follow-up, not required by this slice.

## Read and verification — never inferred from a successful write call

`S3AuditStorage.putImmutable` performs `PutObject`, captures the `VersionId`
S3 returns (when the bucket has versioning enabled), then unconditionally
`HeadObject` + `GetObject` **pinned to that exact version** — not "current" —
and only returns once all of the following hold: downloaded byte content
matches exactly, downloaded content's sha256 matches, `HeadObject`'s
`ContentLength` matches, `ContentType` matches, the `sha256` object-metadata
entry matches, and — when S3 reports it — `ServerSideEncryption` is `AES256`.
Any mismatch throws `AuditIntegrityError` before the write is ever considered
complete. Pinning to the version eliminates any window where a concurrent
write to the same key could be verified against the wrong object.
`LocalAuditStorage` mirrors the same never-trust-the-write-call discipline by
reading its own write back and comparing before returning (it has no
versioning concept, so its `versionId` is always `null`).

`AuditStorage.getImmutable(key, versionId?)` accepts the same pinning: passing
a `versionId` retrieves that exact historical version regardless of what is
currently latest at that key; omitting it resolves to "current", matching
ordinary S3 `GetObject` semantics.

## Persisted lineage (`db/migrations/003_investigation_memory_audit_artifact.sql`)

Five columns on `investigation_memory`, all read and written by
`CockroachDBMemoryStore` (`lib/server/memory-store.ts`) and exposed through
`LatestCaseSnapshot` / `MemoryLineageView`:

| Column | Null when | Notes |
|---|---|---|
| `audit_artifact_key` | no artifact was ever written for this row | |
| `audit_artifact_sha256` | " | lowercase 64-hex, enforced by a CHECK constraint |
| `audit_artifact_backend` | " | `local` or `s3` — **persisted per row**, read back from the row itself, never re-derived from the store's current configuration (so it stays accurate even if `AUDIT_STORAGE_BACKEND` changes between a row's write and a later read) |
| `audit_artifact_version_id` | the backend is `local`, or the S3 bucket didn't report a version | the exact S3 object version this artifact was written as |
| `audit_artifact_verified_at` | no artifact was ever written | when the write path finished independently verifying the artifact — not the row's `created_at` |

`audit_artifact_key`/`sha256`/`backend`/`verified_at` are constrained to be
all-NULL or all-present together; `version_id` is independent (a fully
verified `local` artifact, or an `s3` artifact in a non-versioned bucket, is
still valid with no version_id). See the migration file for the exact CHECK
constraints and why the "S3 always returns a version_id" direction is
enforced in application code/tests rather than SQL — the database cannot know
whether a bucket has versioning enabled.

The client derives `auditVerificationStatus` (`"verified"` /
`"not_available"`) from field presence — never trusted from the wire as its
own boolean — and the Audit panel renders "verified" only when it, and
displays `version_id`/`verified_at` only when present.

## Configuration

Explicit backend selection, fail-closed:

```text
AUDIT_STORAGE_BACKEND=local   # default when unset — the real local adapter, .sherlock/audit/
AUDIT_STORAGE_BACKEND=s3      # requires AWS_S3_AUDIT_BUCKET and AWS_REGION, or getAuditStorage() throws
AWS_S3_AUDIT_BUCKET=<bucket>  # required only when backend=s3
AWS_S3_AUDIT_PREFIX=<prefix>  # optional, e.g. "dev" — no leading/trailing slash required
AWS_REGION=eu-central-1
AWS_PROFILE=prior-dev         # local dev only; read by the AWS SDK itself, never by this codebase
```

`AUDIT_STORAGE_BACKEND=s3` with a missing bucket or region throws immediately
— it never silently falls back to `local`. Credentials are always resolved by
the AWS SDK's own standard provider chain (`AWS_PROFILE` + shared config
locally, an IAM role in AWS); this codebase never reads, accepts, or
serializes an access key or secret anywhere — not via env vars it defines
itself, not via any application field, not into the artifact.

## What's deliberately NOT done yet

- **Not deployed, not run against AWS.** No migration has been applied to any
  cluster; no S3 call has been made against a real bucket. Both are the
  user's explicit next step (see below).
- **No delete/reconciliation tooling.** An orphaned artifact
  (`OrphanedAuditArtifactError`) is surfaced with its key/hash for a human to
  act on; nothing in this codebase automates deleting or reconciling it.
- **No Object Lock — write-once here is application-enforced, not a legal
  hold.** Out of scope for this slice (see the task's stated limits). The
  conditional `PutObject` (`IfNoneMatch`) plus the runtime IAM principal
  having no `DeleteObject` permission stop this application from overwriting
  or deleting an artifact — they do not stop a privileged AWS administrator
  (different or broader IAM permissions, or a change to the bucket policy)
  from deleting or modifying one. That guarantee is what S3 Object Lock/WORM
  would add, and it does not exist yet.
- **No presigned or public URLs anywhere** — the API and UI expose only
  backend/key/sha256/verification-status.

## To actually verify this (run manually — not run by this change)

1. Confirm the dev bucket (already verified manually: private, ACLs
   disabled, versioning on, SSE-S3, IAM restricted to
   `PutObject`/`GetObject`/`GetObjectVersion`/`ListBucket`/`GetBucketLocation`,
   no `DeleteObject`).
2. Apply `db/migrations/003_investigation_memory_audit_artifact.sql` against
   the target cluster (additive; not applied by this change).
3. In `.env.local` (never commit real values):
   ```text
   AUDIT_STORAGE_BACKEND=s3
   AWS_S3_AUDIT_BUCKET=<your dev bucket>
   AWS_REGION=eu-central-1
   AWS_PROFILE=prior-dev
   ```
4. Run the Google SecOps eval (`npm run eval:case-google-secops`) or start
   `npm run dev` and submit the Google SecOps example from the UI.
5. Confirm in S3: the object exists at
   `investigations/case-google-secops-2026/<investigation-id>/<snapshot-id>.json`,
   its content matches what was written, and its stored `sha256` metadata
   matches a locally recomputed hash.
6. Confirm in CockroachDB: the corresponding row's `audit_artifact_key`,
   `audit_artifact_sha256`, and `audit_artifact_backend` (`s3`) match what's
   in S3, `audit_artifact_version_id` matches the S3 object's actual version
   ID (visible in the S3 console or `aws s3api list-object-versions`), and
   `audit_artifact_verified_at` is a real, recent timestamp.
7. Confirm in the Audit & lineage panel: backend `s3`, the artifact key, the
   sha256, the version_id, the verified_at timestamp, and
   "Verification: verified" are all shown.
8. `tests/integration/audit-storage-s3-live.test.ts` follows the same
   excluded-from-`npm test` pattern as
   `tests/integration/memory-store-mcp-live.test.ts`: skipped unless
   `AUDIT_STORAGE_BACKEND=s3` plus bucket/region are set, run explicitly with
   `node --test --import tsx tests/integration/audit-storage-s3-live.test.ts`.
