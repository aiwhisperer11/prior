-- Additive only. No changes to investigation_memory or any other existing
-- table. NOT YET APPLIED to any cluster as of this writing -- run manually
-- when ready; nothing in this codebase runs migrations automatically.
--
-- Two tables back the Governed Evidence Scout feature:
--   evidence_scout_action    -- one row per authorized search action, with
--                                lease/reclaim/attempt fields for the
--                                SQS-dispatched Lambda executor.
--   evidence_scout_candidate -- one row per source candidate returned by a
--                                completed action, including rejected ones
--                                (point 7: persist rejected candidates too).
--
-- A source_candidate is never an EvidenceItem. Only an accepted, eligible
-- (never source_located -- point 8) candidate can ever be linked to a real
-- evidence_id, and only via the single-transaction snapshot-insert +
-- candidate-link path in lib/server/memory-store.ts
-- (saveSnapshotWithEvidenceLinks) -- never at accept-decision time.

CREATE TABLE IF NOT EXISTS evidence_scout_action (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id STRING NOT NULL,
  investigation_id UUID NULL,       -- no FK: investigation_memory.investigation_id has no unique index (only `id` and the partial `source_id` index do)
  missing_evidence_id STRING NULL,
  query_intent STRING NOT NULL,
  queries STRING[] NOT NULL,
  max_candidates INT8 NOT NULL,
  allowed_domains STRING[] NULL,
  idempotency_key STRING NULL,
  state STRING NOT NULL DEFAULT 'authorized',
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  -- Sanitized, closed enum only -- never a raw error message or stack (point
  -- 10). The real error, if any, goes to server-side logs only.
  failure_code STRING NULL,
  search_call_count INT8 NOT NULL DEFAULT 0,
  -- Lease/reclaim: a worker (Lambda invocation triggered by the SQS event
  -- source mapping) claims this row atomically:
  --   UPDATE ... WHERE (state = 'authorized' OR (state = 'searching' AND leased_until < now()))
  --                 AND attempt_count < 3
  -- Handles SQS duplicate delivery (a second concurrent claim attempt
  -- affects 0 rows) and crash recovery (an expired lease becomes
  -- reclaimable). leased_until is sized coherently with the Lambda timeout
  -- (90s) and the SQS visibility timeout (540s, 6x the Lambda timeout per
  -- AWS's documented sizing guidance) -- see infra/evidence-scout-lambda/README.md.
  leased_by STRING NULL,
  leased_until TIMESTAMPTZ NULL,
  attempt_count INT8 NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT evidence_scout_action_state_enum
    CHECK (state IN ('authorized', 'searching', 'completed', 'failed')),
  -- COALESCE is required here: array_length(arr,1) returns NULL (not 0) for
  -- an empty array, and NULL BETWEEN x AND y evaluates to NULL, which a CHECK
  -- constraint treats as passing (only explicit FALSE is rejected) -- without
  -- COALESCE, an empty queries array would silently bypass the "at least 1"
  -- floor.
  CONSTRAINT evidence_scout_action_query_bounds
    CHECK (COALESCE(array_length(queries, 1), 0) BETWEEN 1 AND 2),
  CONSTRAINT evidence_scout_action_domain_cap
    CHECK (allowed_domains IS NULL OR COALESCE(array_length(allowed_domains, 1), 0) <= 20),
  CONSTRAINT evidence_scout_action_candidate_cap
    CHECK (max_candidates BETWEEN 1 AND 5),
  CONSTRAINT evidence_scout_action_attempt_cap
    CHECK (attempt_count <= 3),
  CONSTRAINT evidence_scout_action_lease_with_state
    CHECK ((state = 'searching') = (leased_by IS NOT NULL AND leased_until IS NOT NULL)),
  CONSTRAINT evidence_scout_action_query_intent_length
    CHECK (length(query_intent) BETWEEN 1 AND 500),
  CONSTRAINT evidence_scout_action_failure_code_enum
    CHECK (failure_code IS NULL OR failure_code IN
      ('search_timeout', 'search_api_error', 'invalid_response_shape', 'daily_budget_exceeded', 'max_attempts_exceeded', 'dispatch_failed', 'unknown_error')),
  -- Temporal ordering: only checked when both sides are present -- NULL
  -- comparisons are otherwise silently permissive, the same pitfall as the
  -- array-length case above, fixed here by structure rather than COALESCE
  -- (there is no natural "zero" timestamp to coalesce to).
  CONSTRAINT evidence_scout_action_timestamps_ordered
    CHECK (
      (started_at IS NULL OR started_at >= authorized_at)
      AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    )
);

-- Idempotency (point: "Idempotency-Key obligatorio"): a retried POST
-- /evidence-scout/search with the same (case_id, idempotency_key) returns
-- the existing action instead of authorizing a second search.
CREATE UNIQUE INDEX IF NOT EXISTS evidence_scout_action_idempotency_key_idx
  ON evidence_scout_action (case_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_scout_action_case_id_idx
  ON evidence_scout_action (case_id, created_at DESC);

-- Daily global budget (point 9): a serializable-transaction count of same-day
-- rows against EVIDENCE_SCOUT_DAILY_ACTION_LIMIT. This index makes that count
-- cheap; it does not itself enforce the limit.
CREATE INDEX IF NOT EXISTS evidence_scout_action_created_at_idx
  ON evidence_scout_action (created_at);

CREATE TABLE IF NOT EXISTS evidence_scout_candidate (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES evidence_scout_action(id),
  query STRING NOT NULL,
  publisher STRING NULL,
  document_title STRING NULL,
  source_url STRING NOT NULL,
  claim_summary STRING NOT NULL,      -- model-generated paraphrase; never treated as literal
  cited_text STRING NULL,             -- literal excerpt, only when actually confirmed verbatim
  fragment STRING NULL,
  publication_date STRING NULL,       -- the source's own stated date, when any; free-text to avoid false precision from forcing a partial date into TIMESTAMPTZ
  tier STRING NOT NULL,
  state STRING NOT NULL DEFAULT 'pending',
  verification_status STRING NOT NULL DEFAULT 'source_located',
  source_reliability STRING NOT NULL DEFAULT 'unknown',
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ NULL,
  -- Durable link: candidate -> evidence_id -> snapshot/iteration (point 8 of
  -- the earlier architecture review). Populated only after a follow-up that
  -- included this candidate actually succeeds and persists -- see
  -- saveSnapshotWithEvidenceLinks in lib/server/memory-store.ts, which sets
  -- all three inside the same transaction as the investigation_memory
  -- INSERT. A candidate with evidence_id set is "spent": the guarded
  -- UPDATE ... WHERE evidence_id IS NULL used to set it is what actually
  -- enforces "a candidate can only be spent once" (point 6) -- the CHECK
  -- constraints below only describe the resulting shape, they cannot see a
  -- row's prior value during an UPDATE.
  evidence_id STRING NULL,
  snapshot_id UUID NULL REFERENCES investigation_memory(id),
  iteration INT8 NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT evidence_scout_candidate_state_enum
    CHECK (state IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT evidence_scout_candidate_tier_enum
    CHECK (tier IN ('official_primary', 'institutional', 'reputable_secondary', 'other')),
  -- Three-level verification ladder (point 10).
  CONSTRAINT evidence_scout_candidate_verification_enum
    CHECK (verification_status IN ('source_located', 'citation_supported', 'verified_as_published')),
  -- Point 3: a url_citation alone is never sufficient for verified_as_published.
  CONSTRAINT evidence_scout_candidate_verified_requires_cited_text
    CHECK (verification_status != 'verified_as_published' OR cited_text IS NOT NULL),
  CONSTRAINT evidence_scout_candidate_citation_supported_requires_fragment
    CHECK (verification_status = 'source_located' OR fragment IS NOT NULL),
  CONSTRAINT evidence_scout_candidate_source_reliability_enum
    CHECK (source_reliability IN ('high', 'medium', 'low', 'unknown')),
  CONSTRAINT evidence_scout_candidate_source_url_scheme
    CHECK (source_url ~ '^https?://'),
  CONSTRAINT evidence_scout_candidate_decided_at_with_state
    CHECK ((state = 'pending') = (decided_at IS NULL)),
  CONSTRAINT evidence_scout_candidate_decided_after_retrieved
    CHECK (decided_at IS NULL OR decided_at >= retrieved_at),
  -- Point 7 (persist rejected candidates, but never a full page or
  -- unnecessary content): bounded length, never a full page.
  CONSTRAINT evidence_scout_candidate_fragment_length
    CHECK (fragment IS NULL OR length(fragment) <= 2000),
  CONSTRAINT evidence_scout_candidate_cited_text_length
    CHECK (cited_text IS NULL OR length(cited_text) <= 2000),
  CONSTRAINT evidence_scout_candidate_claim_summary_length
    CHECK (length(claim_summary) BETWEEN 1 AND 1000),
  -- Point 8: only an accepted, eligible candidate can ever be linked.
  CONSTRAINT evidence_scout_candidate_evidence_link_requires_accepted
    CHECK (evidence_id IS NULL OR state = 'accepted'),
  CONSTRAINT evidence_scout_candidate_evidence_link_all_or_nothing
    CHECK ((evidence_id IS NULL) = (snapshot_id IS NULL) AND (evidence_id IS NULL) = (iteration IS NULL))
);

CREATE INDEX IF NOT EXISTS evidence_scout_candidate_action_id_idx
  ON evidence_scout_candidate (action_id);
