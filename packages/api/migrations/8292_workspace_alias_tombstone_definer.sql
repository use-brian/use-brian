-- [COMP:api/db-client] Run the workspace alias tombstone as the table owner.
-- 553 installed tombstone_workspace_link_aliases() as an invoker trigger. The owner-only
-- workspace delete runs on the app pool, and the tombstone row has a NULL workspace, so
-- only the default-true bypass leg of workspace_link_aliases_member admitted it: after a
-- committed transaction-local app.system_bypass the delete was refused. The body is
-- unchanged; only SECURITY DEFINER, the pinned search_path and an owner-only ACL change.
-- No policy changes.
BEGIN;
DO $authenticate$
DECLARE f pg_proc; owner_id oid; runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.workspace_link_aliases'::regclass;
 SELECT * INTO f FROM pg_proc WHERE oid=to_regprocedure('public.tombstone_workspace_link_aliases()');
 IF f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>'740ca94cef20a8b52738de56474d292cf5b1cc477c3b7415595dcc3af3365b83'
  OR f.prosecdef OR f.proconfig IS NOT NULL OR f.proleakproof OR f.proisstrict OR f.proretset
  OR f.provolatile<>'v' OR f.prokind<>'f' OR f.pronargs<>0
  OR f.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR f.prorettype<>'trigger'::regtype
  OR f.proowner<>owner_id
  OR NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=owner_id)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
   WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>owner_id
    OR a.grantee NOT IN (0,owner_id) AND a.grantee IS DISTINCT FROM runtime_id)
 THEN RAISE EXCEPTION 'workspace_alias_tombstone_predecessor_changed'; END IF;
 IF (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.workspace_link_aliases'::regclass) THEN
  RAISE EXCEPTION 'workspace_alias_tombstone_table_forced'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgfoid=f.oid)<>1 OR NOT EXISTS(SELECT 1 FROM pg_trigger
   WHERE tgfoid=f.oid AND tgrelid='public.workspaces'::regclass AND tgname='workspaces_tombstone_internal_links'
    AND NOT tgisinternal AND tgenabled='O' AND tgtype=11)
 THEN RAISE EXCEPTION 'workspace_alias_tombstone_trigger_changed'; END IF;
END $authenticate$;
CREATE OR REPLACE FUNCTION public.tombstone_workspace_link_aliases()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  UPDATE workspace_link_aliases
     SET workspace_id = NULL,
         alias = NULL,
         is_current = false,
         created_by = NULL,
         deleted_at = now()
   WHERE workspace_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.tombstone_workspace_link_aliases() FROM PUBLIC;
DO $revoke_runtime$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION public.tombstone_workspace_link_aliases() FROM app_user;
 END IF;
END $revoke_runtime$;
DO $verify$
DECLARE f pg_proc; owner_id oid;
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.workspace_link_aliases'::regclass;
 SELECT * INTO STRICT f FROM pg_proc WHERE oid='public.tombstone_workspace_link_aliases()'::regprocedure;
 IF encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>'740ca94cef20a8b52738de56474d292cf5b1cc477c3b7415595dcc3af3365b83'
  OR NOT f.prosecdef OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR f.proowner<>owner_id OR f.prorettype<>'trigger'::regtype
  OR (SELECT count(*) FROM aclexplode(f.proacl))<>1
  OR NOT EXISTS(SELECT 1 FROM aclexplode(f.proacl) a WHERE a.grantee=owner_id AND a.grantor=owner_id
   AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
  OR (SELECT count(*) FROM pg_trigger WHERE tgfoid=f.oid AND tgrelid='public.workspaces'::regclass
   AND tgname='workspaces_tombstone_internal_links')<>1
 THEN RAISE EXCEPTION 'workspace_alias_tombstone_successor_changed'; END IF;
END $verify$;
COMMIT;
