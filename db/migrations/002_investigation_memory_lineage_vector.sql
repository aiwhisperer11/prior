-- Additive only: no destructive changes to 001_investigation_memory.sql.
--
-- Adds lineage/idempotency columns (investigation_id, parent_snapshot_id,
-- source_id, model_version, prompt_version) and a real CockroachDB VECTOR
-- column for semantic memory retrieval via Distributed Vector Indexing
-- (C-SPANN, preview as of v25.2+). Dimension 1536 matches OpenAI's
-- text-embedding-3-small (see lib/server/embeddings.ts).
--
-- STATUS: written against current CockroachDB docs
-- (https://www.cockroachlabs.com/docs/v25.2/vector-indexes.html) and run for
-- real against a live cluster on 2026-08-12 (see docs/evaluation.md for the
-- verification log). Run this migration, then the two manual statements at
-- the bottom, against any other CockroachDB v25.2+ cluster before relying on
-- findSemanticPrecedents there.

ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS investigation_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS parent_snapshot_id UUID NULL REFERENCES investigation_memory(id);
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS source_id STRING NOT NULL DEFAULT '';
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS model_version STRING NOT NULL DEFAULT '';
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS prompt_version STRING NOT NULL DEFAULT '';
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);
ALTER TABLE investigation_memory ADD COLUMN IF NOT EXISTS embedding_model STRING NOT NULL DEFAULT '';

-- source_id is the idempotency key (sha256 of a canonical {case_id, iteration,
-- snapshot} fingerprint — see canonicalize() in lib/server/v2-snapshot-store.ts
-- and computeSourceId() in lib/server/memory-store.ts). A retried write with
-- the same source_id is a no-op (INSERT ... ON CONFLICT (source_id) DO
-- NOTHING), not a duplicate row or an error.
--
-- Partial (WHERE source_id != ''): rows written before this migration existed
-- all defaulted to '' and would otherwise collide on a plain unique index.
-- Every row written by this codebase's save() always computes a real,
-- non-empty hash, so the partial index still protects every real write.
CREATE UNIQUE INDEX IF NOT EXISTS investigation_memory_source_id_key ON investigation_memory (source_id) WHERE source_id != '';

CREATE INDEX IF NOT EXISTS investigation_memory_case_id_created_at_idx
  ON investigation_memory (case_id, created_at DESC);

-- --- Manual steps: requires cluster-admin privileges, run separately by an
-- --- operator against the target cluster. The application never executes
-- --- these itself.
--
-- SET CLUSTER SETTING feature.vector_index.enabled = true;
-- CREATE VECTOR INDEX investigation_memory_domain_embedding_idx
--   ON investigation_memory (domain, embedding);
