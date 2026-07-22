-- Edge identity: one ACTIVE row per (workspace, source, target, edge_type).
--
-- `entity_links` had no content-level uniqueness — only a PK on `id` — and
-- edge writers are fire-and-forget (`edge-hooks.ts`), so nothing anywhere
-- prevented the same assertion landing twice. The worst writer was the chat
-- retrieval local-match (`core/src/brain/retrieval-match.ts`): it blind-created
-- a `mentioned` edge on EVERY recall of a memory that names a known entity, so
-- a frequently-recalled memory re-minted the same edge on every chat turn —
-- audited 2026-07-22 at 4,957 duplicate rows out of 5,836 active edges (85% of
-- the table), one edge repeated 946x, growing ~200/day. The dedup design gap:
-- write-time dedup existed for entities (store upsert) and memories
-- (content_hash + consolidation), but edges sat outside every seam.
--
-- Fix in two parts:
--   1. Collapse existing duplicates. Keeper per group: a verified row beats
--      unverified (human trust signal), episode-backed beats provenance-less
--      (retrieval-match passes no episode; Pipeline B always does), then
--      oldest. Hard delete, not retract — these are mechanical duplicates of a
--      surviving identical row, not assertions being withdrawn.
--   2. A partial UNIQUE index over ACTIVE rows only. Bi-temporal semantics are
--      preserved: a closed (`valid_to`) or retracted edge leaves the index, so
--      re-asserting a previously-ended relationship still opens a fresh row,
--      and historical closed rows never collide.
--
-- The store (`entity-links-store.ts:createEntityLink`) pairs this with
-- `ON CONFLICT DO NOTHING` + read-back, making `create` assert-exists for every
-- caller by construction. Deploy order: this migration MUST be applied before
-- the paired store code ships — ON CONFLICT infers this index and fails
-- without it. All six key columns are NOT NULL, so a plain column-list index
-- is portable (PGLite included).
BEGIN;

DELETE FROM entity_links el
 USING (
   SELECT id,
          row_number() OVER (
            PARTITION BY workspace_id, source_kind, source_id,
                         target_kind, target_id, edge_type
            ORDER BY (verified_at IS NOT NULL) DESC,
                     (source_episode_id IS NOT NULL) DESC,
                     created_at ASC, id ASC
          ) AS rn
     FROM entity_links
    WHERE valid_to IS NULL AND retracted_at IS NULL
 ) ranked
 WHERE el.id = ranked.id
   AND ranked.rn > 1;

CREATE UNIQUE INDEX idx_entity_links_active_identity
  ON entity_links (workspace_id, source_kind, source_id, target_kind, target_id, edge_type)
  WHERE valid_to IS NULL AND retracted_at IS NULL;

COMMIT;
