BEGIN;

-- scope_source_ancestors() (567, re-declared unchanged through 588) walked a
-- supersession chain with
--
--   JOIN <table> r ON nullif(to_jsonb(r)->>'superseded_by','')::uuid = a.id
--
-- so every recursion level re-read and jsonb-serialized EVERY row of the
-- workspace (embeddings and TOASTed attributes included): O(chain depth x
-- workspace rows x row size), and no index can serve a jsonb projection.
-- Measured 2026-09-30 in production: 25.8 s for an entity with 10 ancestors in
-- a 2,959-entity workspace, ~2.5 s per level. Repository entities carried
-- 700-link chains, so every `UPDATE entities` (advance_canonical_scope_version
-- -> hold_scope_descendants -> this walk) ran until the background lane's
-- 120 s statement timeout, the compose worker retried it every ~130 s, and the
-- db-f1-micro spent the whole period disk-bound: brian-api's 2-connection pool
-- queued ten deep and a POST /api/recordings/live/start took 25 s.
--
-- Walk the real column, which the planner can hash-join or index (8 ms for the
-- same 703-link chain), and skip the recursion entirely for source tables that
-- have no `superseded_by` column: the jsonb projection was always NULL there,
-- so the old walk scanned the table once to find nothing.

CREATE OR REPLACE FUNCTION scope_source_ancestors(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text; versioned boolean;
BEGIN
  IF p_kind IN('crm_event','memory_verification','brain_verification','correction_audit') THEN RETURN QUERY SELECT p_id; RETURN; END IF;
  tab=scope_source_table(p_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  SELECT EXISTS(
    SELECT 1 FROM pg_attribute
     WHERE attrelid=format('%I',tab)::regclass AND attname='superseded_by' AND NOT attisdropped
  ) INTO versioned;
  IF NOT versioned THEN
    RETURN QUERY EXECUTE format('SELECT id FROM %I WHERE workspace_id=$2 AND id=$1',tab) USING p_id,p_workspace;
    RETURN;
  END IF;
  RETURN QUERY EXECUTE format('WITH RECURSIVE ancestry(id) AS (
    SELECT id FROM %I WHERE workspace_id=$2 AND id=$1
    UNION SELECT r.id FROM %I r JOIN ancestry a ON r.superseded_by=a.id WHERE r.workspace_id=$2)
    SELECT id FROM ancestry',tab,tab) USING p_id,p_workspace;
END;
$$;

COMMIT;
