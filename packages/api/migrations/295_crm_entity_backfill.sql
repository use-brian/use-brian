-- Migration 295 — CRM → entity backfill (ADDITIVE; the table drop is 296).
--
-- Part of docs/plans/crm-entity-unification.md. Collapses the CRM
-- specialization tables (contacts/companies/deals, mig 114 + entity_id
-- FK mig 127) into the single `entities` table:
--   * typed fields  → entities.attributes (JSONB)
--   * relationships → entity_links edges (works_at / engagement_of /
--                     represents — all existing seed edge types)
--   * audit rows    → repointed from the CRM row to its entity (D6)
--
-- This migration DROPS NOTHING. It only enriches entities so that, once
-- the code cutover (plan §3) repoints every reader and writer, migration
-- 296 can drop the three tables cleanly. Authoring the drop separately is
-- what keeps every intermediate checkpoint green in a live tree (plan §5
-- authoring-order refinement to D3).
--
-- Data shape at authoring time (prod, 2026-07-01): 120 live contacts,
-- 47 live companies, 0 live deals, 0 brain-blind (entity_id IS NULL)
-- rows, 2 brain_verifications rows to repoint, 0 correction_audit. The
-- mint-for-brain-blind path below is therefore a no-op in prod but is
-- kept correct for local/dev DBs that may hold pre-Q24 rows.

BEGIN;

-- ── 1. Mint entities for brain-blind CRM rows (entity_id IS NULL) ──────
-- Pre-Q24 rows (created in the mig-114→127 window) never got a graph
-- node. Give each live one an entity so steps 2-4 have a target. A
-- PL/pgSQL loop (vs a set-based CTE) is used deliberately: the row count
-- is ~0, and the loop is unambiguously correct about correlating each
-- new entity id back to its CRM row. Universal columns carry across
-- verbatim; entities.created_by_user_id is NOT NULL so we COALESCE onto
-- user_id (a brain-blind row with neither is anomalous and will fail
-- loudly rather than silently drop data).
-- Author resolution: entities.created_by_user_id is NOT NULL and the
-- visibility CHECK needs user_id OR assistant_id. A brain-blind CRM row
-- may carry neither (stale imports); fall back to the workspace owner,
-- and skip (with a NOTICE) only the unrecoverable orphan whose workspace
-- has no owner — better than aborting the whole migration on junk rows.
DO $$
DECLARE r RECORD; new_id uuid; author uuid; vis_user uuid;
BEGIN
  FOR r IN SELECT * FROM contacts WHERE entity_id IS NULL AND valid_to IS NULL LOOP
    author   := COALESCE(r.created_by_user_id, r.user_id,
                         (SELECT owner_user_id FROM workspaces w WHERE w.id = r.workspace_id));
    vis_user := COALESCE(r.user_id, author);
    IF author IS NULL OR vis_user IS NULL THEN
      RAISE NOTICE 'crm-collapse: skip brain-blind contact % (workspace % has no resolvable author)', r.id, r.workspace_id;
      CONTINUE;
    END IF;
    INSERT INTO entities (kind, display_name, canonical_id, sensitivity, workspace_id,
      user_id, assistant_id, created_by_user_id, created_by_assistant_id, source_episode_id,
      source, verified_by_user_id, verified_at, valid_from, created_at, updated_at, compartments)
    VALUES ('person', r.name, r.email, r.sensitivity, r.workspace_id,
      vis_user, r.assistant_id, author, r.created_by_assistant_id,
      r.source_episode_id, r.source, r.verified_by_user_id, r.verified_at, r.valid_from,
      r.created_at, r.updated_at, r.compartments)
    RETURNING id INTO new_id;
    UPDATE contacts SET entity_id = new_id WHERE id = r.id;
  END LOOP;

  FOR r IN SELECT * FROM companies WHERE entity_id IS NULL AND valid_to IS NULL LOOP
    author   := COALESCE(r.created_by_user_id, r.user_id,
                         (SELECT owner_user_id FROM workspaces w WHERE w.id = r.workspace_id));
    vis_user := COALESCE(r.user_id, author);
    IF author IS NULL OR vis_user IS NULL THEN
      RAISE NOTICE 'crm-collapse: skip brain-blind company % (workspace % has no resolvable author)', r.id, r.workspace_id;
      CONTINUE;
    END IF;
    INSERT INTO entities (kind, display_name, canonical_id, sensitivity, workspace_id,
      user_id, assistant_id, created_by_user_id, created_by_assistant_id, source_episode_id,
      source, verified_by_user_id, verified_at, valid_from, created_at, updated_at, compartments)
    VALUES ('company', r.name, r.domain, r.sensitivity, r.workspace_id,
      vis_user, r.assistant_id, author, r.created_by_assistant_id,
      r.source_episode_id, r.source, r.verified_by_user_id, r.verified_at, r.valid_from,
      r.created_at, r.updated_at, r.compartments)
    RETURNING id INTO new_id;
    UPDATE companies SET entity_id = new_id WHERE id = r.id;
  END LOOP;

  -- Deals have no canonical_id and derive display_name from the linked
  -- company (mirrors createDeal in crm.ts). Fallback 'Deal' when unlinked.
  FOR r IN SELECT * FROM deals WHERE entity_id IS NULL AND valid_to IS NULL LOOP
    author   := COALESCE(r.created_by_user_id, r.user_id,
                         (SELECT owner_user_id FROM workspaces w WHERE w.id = r.workspace_id));
    vis_user := COALESCE(r.user_id, author);
    IF author IS NULL OR vis_user IS NULL THEN
      RAISE NOTICE 'crm-collapse: skip brain-blind deal % (workspace % has no resolvable author)', r.id, r.workspace_id;
      CONTINUE;
    END IF;
    INSERT INTO entities (kind, display_name, sensitivity, workspace_id,
      user_id, assistant_id, created_by_user_id, created_by_assistant_id, source_episode_id,
      source, verified_by_user_id, verified_at, valid_from, created_at, updated_at, compartments)
    VALUES ('deal',
      COALESCE((SELECT name FROM companies co WHERE co.id = r.company_id), 'Deal'),
      r.sensitivity, r.workspace_id,
      vis_user, r.assistant_id, author, r.created_by_assistant_id,
      r.source_episode_id, r.source, r.verified_by_user_id, r.verified_at, r.valid_from,
      r.created_at, r.updated_at, r.compartments)
    RETURNING id INTO new_id;
    UPDATE deals SET entity_id = new_id WHERE id = r.id;
  END LOOP;
END $$;

-- ── 2. Merge typed CRM fields into the linked entity's attributes ──────
-- jsonb_strip_nulls drops keys whose value is SQL NULL; empty tag arrays
-- and empty external_ref ({}) are coerced to NULL first so we never
-- stamp noise. `attributes || …` is last-writer-wins (the CRM field
-- overrides a prior key of the same name). Only live→live pairs merge.

-- The relationship FK is stored in attributes (record source of truth,
-- holding the *entity* id of the referenced company/contact), translated
-- from the CRM row's FK. Edges (§3 below) are the graph-only projection.
UPDATE entities e
   SET attributes = e.attributes || jsonb_strip_nulls(jsonb_build_object(
         'email',        c.email,
         'phone',        c.phone,
         'company_id',   (SELECT co.entity_id FROM companies co
                           WHERE co.id = c.company_id AND co.valid_to IS NULL),
         'tags',         CASE WHEN cardinality(c.tags) > 0 THEN to_jsonb(c.tags) END,
         'external_ref', NULLIF(c.external_ref, '{}'::jsonb)
       )),
       updated_at = now()
  FROM contacts c
 WHERE c.entity_id = e.id AND c.valid_to IS NULL AND e.valid_to IS NULL;

UPDATE entities e
   SET attributes = e.attributes || jsonb_strip_nulls(jsonb_build_object(
         'domain',       co.domain,
         'tags',         CASE WHEN cardinality(co.tags) > 0 THEN to_jsonb(co.tags) END,
         'external_ref', NULLIF(co.external_ref, '{}'::jsonb)
       )),
       updated_at = now()
  FROM companies co
 WHERE co.entity_id = e.id AND co.valid_to IS NULL AND e.valid_to IS NULL;

UPDATE entities e
   SET attributes = e.attributes || jsonb_strip_nulls(jsonb_build_object(
         'stage',        d.stage,
         'amount',       d.amount,
         'close_date',   d.close_date,
         'contact_id',   (SELECT c.entity_id FROM contacts c
                           WHERE c.id = d.contact_id AND c.valid_to IS NULL),
         'company_id',   (SELECT co.entity_id FROM companies co
                           WHERE co.id = d.company_id AND co.valid_to IS NULL),
         'external_ref', NULLIF(d.external_ref, '{}'::jsonb)
       )),
       updated_at = now()
  FROM deals d
 WHERE d.entity_id = e.id AND d.valid_to IS NULL AND e.valid_to IS NULL;

-- ── 3. Ensure relationship edges (dedup against existing live edges) ───
-- The CRM write path already emits works_at + engagement_of as
-- fire-and-forget hooks, so many edges pre-exist; NOT EXISTS makes this
-- idempotent. `represents` (contact → deal) was never auto-emitted, so
-- it is materialised here for every deal.contact_id. Edge visibility
-- (user_id OR assistant_id) inherits from the source CRM row.

-- contact → company : works_at
INSERT INTO entity_links (source_kind, source_id, target_kind, target_id, edge_type,
                          source, user_id, assistant_id, workspace_id, sensitivity)
SELECT 'entity', c.entity_id, 'entity', co.entity_id, 'works_at',
       'user', ce.user_id, ce.assistant_id, c.workspace_id, 'internal'
  FROM contacts c
  JOIN companies co ON co.id = c.company_id AND co.valid_to IS NULL
  JOIN entities ce ON ce.id = c.entity_id
 WHERE c.valid_to IS NULL AND c.entity_id IS NOT NULL AND co.entity_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM entity_links el
      WHERE el.source_kind = 'entity' AND el.source_id = c.entity_id
        AND el.target_kind = 'entity' AND el.target_id = co.entity_id
        AND el.edge_type = 'works_at' AND el.valid_to IS NULL AND el.retracted_at IS NULL);

-- deal → company : engagement_of
INSERT INTO entity_links (source_kind, source_id, target_kind, target_id, edge_type,
                          source, user_id, assistant_id, workspace_id, sensitivity)
SELECT 'entity', d.entity_id, 'entity', co.entity_id, 'engagement_of',
       'user', de.user_id, de.assistant_id, d.workspace_id, 'internal'
  FROM deals d
  JOIN companies co ON co.id = d.company_id AND co.valid_to IS NULL
  JOIN entities de ON de.id = d.entity_id
 WHERE d.valid_to IS NULL AND d.entity_id IS NOT NULL AND co.entity_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM entity_links el
      WHERE el.source_kind = 'entity' AND el.source_id = d.entity_id
        AND el.target_kind = 'entity' AND el.target_id = co.entity_id
        AND el.edge_type = 'engagement_of' AND el.valid_to IS NULL AND el.retracted_at IS NULL);

-- contact → deal : represents (person advocates deal)
INSERT INTO entity_links (source_kind, source_id, target_kind, target_id, edge_type,
                          source, user_id, assistant_id, workspace_id, sensitivity)
SELECT 'entity', c.entity_id, 'entity', d.entity_id, 'represents',
       'user', ce.user_id, ce.assistant_id, d.workspace_id, 'internal'
  FROM deals d
  JOIN contacts c ON c.id = d.contact_id AND c.valid_to IS NULL
  JOIN entities ce ON ce.id = c.entity_id
 WHERE d.valid_to IS NULL AND d.entity_id IS NOT NULL AND c.entity_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM entity_links el
      WHERE el.source_kind = 'entity' AND el.source_id = c.entity_id
        AND el.target_kind = 'entity' AND el.target_id = d.entity_id
        AND el.edge_type = 'represents' AND el.valid_to IS NULL AND el.retracted_at IS NULL);

-- ── 4. Repoint audit + verification rows CRM → entity (D6) ─────────────
-- A bv/correction_audit row may reference a SUPERSEDED CRM row, whose
-- entity_id was released to NULL when the live successor claimed it
-- (crm.ts supersession). So we cannot join CRM.id → entity_id directly;
-- we build a chain map that propagates the live head's entity_id back to
-- every ancestor row via `superseded_by`, then repoint through the map.
-- Rows whose target CRM record was later DELETED (its chain reaches no
-- live entity) are left untouched here — migration 296 deletes those
-- residual dangling audit rows before it tightens the target_kind CHECK.

CREATE TEMP TABLE crm_entity_map (crm_kind text, crm_id uuid, entity_id uuid) ON COMMIT DROP;

WITH RECURSIVE m AS (
  SELECT id, entity_id FROM contacts WHERE valid_to IS NULL AND entity_id IS NOT NULL
  UNION ALL
  SELECT c.id, m.entity_id FROM contacts c JOIN m ON c.superseded_by = m.id
)
INSERT INTO crm_entity_map SELECT 'contact', id, entity_id FROM m;

WITH RECURSIVE m AS (
  SELECT id, entity_id FROM companies WHERE valid_to IS NULL AND entity_id IS NOT NULL
  UNION ALL
  SELECT c.id, m.entity_id FROM companies c JOIN m ON c.superseded_by = m.id
)
INSERT INTO crm_entity_map SELECT 'company', id, entity_id FROM m;

WITH RECURSIVE m AS (
  SELECT id, entity_id FROM deals WHERE valid_to IS NULL AND entity_id IS NOT NULL
  UNION ALL
  SELECT d.id, m.entity_id FROM deals d JOIN m ON d.superseded_by = m.id
)
INSERT INTO crm_entity_map SELECT 'deal', id, entity_id FROM m;

UPDATE brain_verifications bv
   SET target_kind = 'entity', target_id = map.entity_id
  FROM crm_entity_map map
 WHERE bv.target_kind = map.crm_kind AND bv.target_id = map.crm_id;

UPDATE correction_audit ca
   SET primitive = 'entity', row_id = map.entity_id
  FROM crm_entity_map map
 WHERE ca.primitive = map.crm_kind AND ca.row_id = map.crm_id;

-- ── 5. Expression indexes for the aggregate() hot paths (deals) ────────
-- Deal pipeline queries move from typed columns to JSONB paths; index the
-- three fields aggregate()/list filters touch. Partial on kind='deal' so
-- the index stays small.
CREATE INDEX IF NOT EXISTS entities_attr_stage_idx
  ON entities ((attributes->>'stage')) WHERE kind = 'deal';
CREATE INDEX IF NOT EXISTS entities_attr_amount_idx
  ON entities (((attributes->>'amount')::numeric)) WHERE kind = 'deal';
CREATE INDEX IF NOT EXISTS entities_attr_close_date_idx
  ON entities ((attributes->>'close_date')) WHERE kind = 'deal';

COMMIT;
