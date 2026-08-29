-- Retroactive rebuild (docs/plans/turn-ledger-and-brain-history.md §6 -
-- the product bet): re-derive a workspace's brain from its retained
-- episode history at a newer pipeline version, into a SHADOW namespace,
-- then promote atomically.
--
-- The shadow is a separate table (memories_shadow), not a flag column on
-- memories: the live brain's retrieval predicates stay untouched (the
-- plan §5 rule) and a half-derived rebuild can never leak into live
-- retrieval. Promote is one transaction: capture the live derived rows
-- into brain_row_versions (so promote is itself reversible), delete
-- them, move the shadow rows in, stamp the run promoted.

BEGIN;

CREATE TABLE rebuild_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'probed'
                           CHECK (status IN ('probed','confirmed','deriving','derived','promoted','failed','cancelled')),
  target_pipeline_version  INTEGER NOT NULL CHECK (target_pipeline_version >= 1),
  -- The cheap pre-flight: episode count + token estimate. Never the
  -- expensive work itself (preflight-confirmation.md).
  probe                    JSONB NOT NULL DEFAULT '{}',
  progress                 JSONB NOT NULL DEFAULT '{}',
  diff                     JSONB,
  error                    TEXT,
  created_by_user_id       UUID,
  confirmed_at             TIMESTAMPTZ,
  derived_at               TIMESTAMPTZ,
  promoted_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rebuild_runs_workspace ON rebuild_runs (workspace_id, created_at DESC);

-- Shadow namespace: column-identical to memories (defaults + constraints)
-- plus the run key and the derivation stamp.
CREATE TABLE memories_shadow (LIKE memories INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE memories_shadow ADD COLUMN rebuild_run_id UUID NOT NULL;
ALTER TABLE memories_shadow ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories_shadow ADD PRIMARY KEY (id);

CREATE INDEX idx_memories_shadow_run ON memories_shadow (rebuild_run_id);

-- Which derivation produced each live memory. Backfilled as 1 (the
-- pre-rebuild pipeline); promote stamps the run's target version.
ALTER TABLE memories ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE rebuild_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories_shadow ENABLE ROW LEVEL SECURITY;

COMMIT;
