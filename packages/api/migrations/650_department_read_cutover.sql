BEGIN;

-- Permission model v2 cutover (decision D22, platform
-- docs/plans/permission-model-v2.md). Every workspace, existing and new,
-- reads through the v2 rule of migration 649 from here on. Applied while no
-- workspace uses departments, so every live row is General, where v2 and the
-- legacy rule agree. Rollback for one workspace is
--   UPDATE workspaces SET department_read_v2 = false WHERE id = ...;
-- the edges stay. Spec: docs/architecture/context-engine/scoped-context.md ->
-- "Reference predicate (v2)".

-- Legacy membership-shaped writes keep the edges in step. Until the
-- Departments screen (Phase 3) writes edges directly, the existing Team,
-- member, assistant-scope, grant and manager surfaces still write the legacy
-- tables; each such write re-runs the owning workspace's idempotent backfill,
-- so what those screens grant is what v2 reads. Writes only v2 tables.
CREATE FUNCTION public.sync_department_edges() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ws uuid;
BEGIN
  FOR ws IN
    SELECT DISTINCT coalesce((x ->> 'workspace_id')::uuid,
             (SELECT g.workspace_id FROM public.workspace_groups g WHERE g.id = (x ->> 'group_id')::uuid))
      FROM (VALUES (CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END),
                   (CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END)) AS v(x)
     WHERE x IS NOT NULL
  LOOP
    -- A cascade from a deleted workspace has nothing left to reconcile.
    IF ws IS NOT NULL AND EXISTS (SELECT 1 FROM public.workspaces WHERE id = ws) THEN
      PERFORM public.department_edges_reconcile(ws);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.sync_department_edges() FROM PUBLIC;

CREATE TRIGGER zz_department_edges_sync AFTER INSERT OR DELETE OR UPDATE OF role, clearance, compartments, team_scope_mode
  ON public.workspace_members FOR EACH ROW EXECUTE FUNCTION public.sync_department_edges();
CREATE TRIGGER zz_department_edges_sync AFTER INSERT OR DELETE OR UPDATE
  ON public.workspace_group_members FOR EACH ROW EXECUTE FUNCTION public.sync_department_edges();
CREATE TRIGGER zz_department_edges_sync AFTER INSERT OR DELETE OR UPDATE
  ON public.workspace_group_assistants FOR EACH ROW EXECUTE FUNCTION public.sync_department_edges();
CREATE TRIGGER zz_department_edges_sync AFTER INSERT OR DELETE OR UPDATE
  ON public.workspace_group_compartment_grants FOR EACH ROW EXECUTE FUNCTION public.sync_department_edges();
CREATE TRIGGER zz_department_edges_sync AFTER UPDATE OF read_all, status
  ON public.workspace_groups FOR EACH ROW EXECUTE FUNCTION public.sync_department_edges();
CREATE TRIGGER zz_department_edges_sync AFTER INSERT OR UPDATE
  ON public.workspace_access_grants FOR EACH ROW EXECUTE FUNCTION public.sync_department_edges();
CREATE TRIGGER zz_department_edges_sync AFTER INSERT OR DELETE OR UPDATE
  ON public.workspace_team_managers FOR EACH ROW EXECUTE FUNCTION public.sync_department_edges();
CREATE TRIGGER zz_department_edges_sync AFTER INSERT OR UPDATE OF team_scope_mode, compartments, clearance, kind
  ON public.assistants FOR EACH ROW EXECUTE FUNCTION public.sync_department_edges();

-- 649 published department_row_allows failing closed on any non-department
-- label. Departments are the only group (P1), so from the cutover such a label
-- restricts nothing: a row is read by its department labels alone, or as
-- General when it has none. Same signature, so every 649 policy picks it up.
CREATE OR REPLACE FUNCTION public.department_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[], row_user uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN w IS NULL OR NOT (grants ? w::text) THEN true ELSE coalesce((
    SELECT public.sensitivity_rank(sensitivity) IS NOT NULL
       AND (row_user IS NULL OR row_user::text = (g.v ->> 'u'))
       AND CASE WHEN ds.ids IS NULL
                THEN public.sensitivity_rank(sensitivity) <= (g.v ->> 'b')::int
                ELSE NOT EXISTS (SELECT 1 FROM unnest(ds.ids) AS d(id)
                                  WHERE NOT coalesce(public.sensitivity_rank(sensitivity) <= ((g.v -> 'd') ->> d.id)::int, false))
           END
       AND (jsonb_typeof(g.v -> 'c') IS DISTINCT FROM 'string' OR ds.ids IS NULL OR (g.v ->> 'c') = ANY (ds.ids))
       AND (jsonb_typeof(g.v -> 'k') IS DISTINCT FROM 'array' OR ds.ids IS NULL
            OR ds.ids <@ ARRAY(SELECT jsonb_array_elements_text(g.v -> 'k')))
      FROM (SELECT grants -> w::text AS v) g,
           (SELECT array_agg(substr(k, 6)) FILTER (WHERE k LIKE 'team:%') AS ids
              FROM unnest(coalesce(compartments, '{}'::text[])) AS k) ds
  ), false) END
$$;

-- Departments are the only group (P1). Every non-department label (the old
-- free-form compartments) is removed from every labelled row; a row left with
-- no department is General. Audit history keeps what it recorded. Triggers are
-- bypassed for this one relabel: it neither versions content nor fires the
-- sync above (the reconcile below runs once for every workspace anyway).
SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type = 'ARRAY' AND c.udt_name = '_text'
       AND c.column_name ILIKE '%compartments'
       AND c.table_name NOT IN ('analytics_events', 'context_scope_reclassification_events')
  LOOP
    EXECUTE format(
      'UPDATE public.%I SET %I = ARRAY(SELECT k FROM unnest(%I) AS k WHERE k LIKE ''team:%%'' ORDER BY k)
        WHERE EXISTS (SELECT 1 FROM unnest(%I) AS k WHERE k IS NULL OR k NOT LIKE ''team:%%'')',
      r.table_name, r.column_name, r.column_name, r.column_name);
  END LOOP;
END $$;
SET LOCAL session_replication_role = origin;
DELETE FROM public.member_compartment_grants WHERE compartment_key NOT LIKE 'team:%';
DELETE FROM public.workspace_group_compartment_grants WHERE compartment_key NOT LIKE 'team:%';
DELETE FROM public.workspace_compartments WHERE managed_by IS NULL;

-- Edges reflect the legacy state at the moment of the flip (I19).
SELECT public.department_edges_reconcile(w.id) FROM public.workspaces w ORDER BY w.id;

ALTER TABLE public.workspaces ALTER COLUMN department_read_v2 SET DEFAULT true;
UPDATE public.workspaces SET department_read_v2 = true WHERE NOT department_read_v2;

COMMIT;
