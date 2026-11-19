-- [COMP:api/db-client] Role-based owner access for the last forced default-true bypass tables.
-- These eight tables kept FORCE ROW LEVEL SECURITY after 269 with a permissive
-- COALESCE(current_setting('app.system_bypass',true),'true')='true' policy. Once a
-- pooled owner connection has set that value locally it reads '' and the owner is
-- refused. The owner bypasses by ownership instead (82200 precedent). RLS stays
-- enabled and every policy is unchanged, so app_user access is exactly as before.
BEGIN;
DO $retire$
DECLARE target record; bypass text:=$e$(COALESCE(current_setting('app.system_bypass'::text, true), 'true'::text) = 'true'::text)$e$;
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('task_rules','task_rules_system_bypass'),('task_tombstones','task_tombstones_system_bypass'),
  ('task_candidates','task_candidates_system_bypass'),('workspace_brands','workspace_brands_system_bypass'),
  ('workspace_brand_versions','brand_versions_system_bypass'),('realtime_thread_targets','realtime_thread_targets_system_bypass'),
  ('page_link_aliases','page_link_aliases_member'),('workspace_link_aliases','workspace_link_aliases_member')) v(rel,policy)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid
    WHERE c.oid=to_regclass('public.'||target.rel) AND c.relrowsecurity AND c.relforcerowsecurity
    AND p.polname=target.policy AND p.polpermissive AND p.polcmd='*' AND p.polroles=ARRAY[0::oid]
    AND position(bypass IN pg_get_expr(p.polqual,p.polrelid))>0)
  THEN RAISE EXCEPTION 'owner_forced_rls_predecessor_changed: %',target.rel; END IF;
  EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY',target.rel);
 END LOOP;
 -- No forced table may keep a default-true bypass policy.
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid WHERE c.relforcerowsecurity
   AND position('COALESCE(current_setting(''app.system_bypass''' IN coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''))>0)
 THEN RAISE EXCEPTION 'owner_forced_rls_default_true_remains'; END IF;
END $retire$;
COMMIT;
