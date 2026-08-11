CREATE TABLE IF NOT EXISTS investigation_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id STRING NOT NULL,
  case_title STRING NOT NULL,
  domain STRING NOT NULL,
  iteration INT8 NOT NULL,
  is_mock BOOL NOT NULL DEFAULT false,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investigation_memory_domain_created_at_idx
  ON investigation_memory (domain, created_at DESC);
