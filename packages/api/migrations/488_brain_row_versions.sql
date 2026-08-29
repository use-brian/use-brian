-- Brain history — the version sidecar (docs/plans/turn-ledger-and-brain-history.md §5).
--
-- Current tables stay exactly as they are (CRUD projections, stable ids,
-- unchanged FKs and retrieval predicates); every DESTRUCTIVE mutation of a
-- brain-derived row appends its before-image here first, so "the row as of
-- T" stays answerable after consolidation prunes, merges, bulk deletes, and
-- identity heals. The schema is primitive-generic from day one (memories are
-- the v1 write path; entities/knowledge follow with no migration).
--
-- Deliberately NOT captured here: the adjust/supersede path (updateMemory
-- already preserves history in-table via valid_to + superseded_by chains),
-- pure signal counters (recall counts, consolidation scores), and the
-- operator erasure path (applyHardPurge — erasure must not mint a new
-- content copy; its correction_audit row is the tombstone, and the as-of
-- resolver surfaces it as an explicit erased marker).
--
-- before_image excludes the embedding: historical reads are id-keyed,
-- never vector-searched.

BEGIN;

CREATE TABLE brain_row_versions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  primitive          TEXT NOT NULL,
  row_id             UUID NOT NULL,
  version_no         INTEGER NOT NULL CHECK (version_no >= 1),
  -- The row as it stood immediately before the mutation. NULL only after
  -- a later erasure wiped it (erased_at is then set).
  before_image       JSONB,
  erased_at          TIMESTAMPTZ,
  -- The window during which before_image WAS the live row: valid_from =
  -- the previous version's valid_to (or the row's created_at), valid_to =
  -- the mutation moment.
  valid_from         TIMESTAMPTZ NOT NULL,
  valid_to           TIMESTAMPTZ NOT NULL,
  mutation_actor     TEXT NOT NULL CHECK (mutation_actor IN ('assistant_turn','consolidation_run','human_edit','workflow_step','a2a')),
  mutation_reason    TEXT NOT NULL DEFAULT 'delete',
  -- Links to the turn_events mutation row emitted with the capture. No FK:
  -- both writes are system-lane and the ledger row is fire-and-forget.
  mutation_event_id  UUID,
  sensitivity        TEXT NOT NULL DEFAULT 'internal',
  workspace_id       UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (primitive, row_id, version_no)
);

CREATE INDEX idx_brain_row_versions_row ON brain_row_versions (primitive, row_id, valid_to);
CREATE INDEX idx_brain_row_versions_workspace ON brain_row_versions (workspace_id, created_at);

-- System-only, like turn_events: writes happen under store mutations, reads
-- are route/tool-gated with the D7 rule (current classification gates
-- historical versions — time-travel applies to data, never permissions).
ALTER TABLE brain_row_versions ENABLE ROW LEVEL SECURITY;

COMMIT;
