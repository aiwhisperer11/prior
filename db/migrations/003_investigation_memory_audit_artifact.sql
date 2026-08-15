-- Additive only: no destructive changes to 001/002, no backfill of existing
-- rows. NOT YET APPLIED to any cluster as of this writing — run manually
-- when ready; nothing in this codebase runs migrations automatically.
--
-- Adds the S3 audit-artifact lineage columns written by
-- CockroachDBMemoryStore.save() (lib/server/memory-store.ts) for that
-- snapshot's canonical audit envelope (lib/server/audit-artifact.ts):
--   audit_artifact_key          -- object key of the artifact in audit storage
--   audit_artifact_sha256       -- content sha256, independent of backend
--   audit_artifact_backend      -- "local" or "s3": which backend actually wrote it
--   audit_artifact_version_id   -- the exact S3 object version (VersionId), when
--                                  the bucket has versioning enabled and S3 reports
--                                  one; always NULL for the "local" backend
--   audit_artifact_verified_at  -- when the write path finished independently
--                                  verifying the artifact (HeadObject + GetObject
--                                  + content/hash/metadata comparison) — not the
--                                  row's created_at
--
-- All five are nullable together: every row written before this feature
-- existed (and every row saved through LocalMemoryStore's ephemeral dev
-- fallback, which is not wired to audit storage) legitimately has none of
-- them and never will retroactively. NULL here means "no artifact was ever
-- produced for this row", not "unknown" or "pending" — the API and Audit UI
-- must show that as an honest absence, never as "verified".
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS audit_artifact_key STRING NULL;
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS audit_artifact_sha256 STRING NULL;
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS audit_artifact_backend STRING NULL;
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS audit_artifact_version_id STRING NULL;
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS audit_artifact_verified_at TIMESTAMPTZ NULL;

-- Legacy-compatible constraints. Written against current CockroachDB docs
-- (ADD CONSTRAINT IF NOT EXISTS, supported since v22.2) but — like the rest
-- of this migration — NOT run against a live cluster as of this writing;
-- spot-check this syntax against the target cluster version before applying.
--
-- 1) key/sha256/backend/verified_at rise and fall together: either every
--    historical/legacy row (none of them), or every row this feature wrote
--    (all of them). version_id is deliberately NOT in this group — a "local"
--    write, or an "s3" write to a bucket without versioning enabled, is
--    still a fully valid, fully verified artifact with no version_id at all.
ALTER TABLE investigation_memory ADD CONSTRAINT IF NOT EXISTS investigation_memory_audit_artifact_all_or_nothing
  CHECK (
    (audit_artifact_key IS NULL AND audit_artifact_sha256 IS NULL AND audit_artifact_backend IS NULL AND audit_artifact_verified_at IS NULL)
    OR
    (audit_artifact_key IS NOT NULL AND audit_artifact_sha256 IS NOT NULL AND audit_artifact_backend IS NOT NULL AND audit_artifact_verified_at IS NOT NULL)
  );

-- 2) backend is exactly one of the two adapters this codebase implements.
ALTER TABLE investigation_memory ADD CONSTRAINT IF NOT EXISTS investigation_memory_audit_artifact_backend_enum
  CHECK (audit_artifact_backend IS NULL OR audit_artifact_backend IN ('local', 's3'));

-- 3) sha256 is always a lowercase 64-hex-character digest when present.
ALTER TABLE investigation_memory ADD CONSTRAINT IF NOT EXISTS investigation_memory_audit_artifact_sha256_format
  CHECK (audit_artifact_sha256 IS NULL OR audit_artifact_sha256 ~ '^[0-9a-f]{64}$');

-- 4) a version_id can only ever belong to an S3-backed artifact (the "local"
--    backend has no versioning concept at all). This is the direction the
--    database CAN enforce. The reverse — "if backend is s3, a version_id
--    must be present whenever the provider actually returned one" — is
--    deliberately NOT expressed here: whether S3 returns a VersionId depends
--    on whether the bucket has versioning enabled, which is an external fact
--    this database has no way to know. That direction is enforced in
--    application code instead: S3AuditStorage.putImmutable
--    (lib/server/audit-storage.ts) always captures and returns whatever
--    VersionId PutObject reports, CockroachDBMemoryStore.save()
--    (lib/server/memory-store.ts) always persists exactly what it received,
--    and this is covered by regression tests (tests/audit-storage.test.ts,
--    tests/memory-store-vector.test.ts) rather than a CHECK constraint that
--    cannot see outside the database.
ALTER TABLE investigation_memory ADD CONSTRAINT IF NOT EXISTS investigation_memory_audit_artifact_version_id_requires_s3
  CHECK (audit_artifact_version_id IS NULL OR audit_artifact_backend = 's3');
