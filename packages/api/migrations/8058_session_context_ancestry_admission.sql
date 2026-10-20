-- Current transaction persistent ancestry. [COMP:api/application-persistence]
BEGIN;

-- No content is returned. A separate owner connection cannot observe a new
-- native derivation/field observation before commit. Keep this walk in the
-- actual admitted transaction and return no partial metadata on refusal.
CREATE FUNCTION read_admitted_session_context_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE node record;admitted jsonb;collected jsonb:='[]';
BEGIN
 FOR node IN SELECT * FROM application_scope_lineage(w,kinds,ids,versions)
  WHERE kind='session_context_revision' LOOP
  admitted:=read_admitted_native_scope_snapshot(w,node.kind,node.id);
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false'
   OR admitted->>'workspaceId' IS DISTINCT FROM w::text
   OR admitted->>'version' IS DISTINCT FROM node.version THEN
   RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
  collected:=collected||jsonb_build_array(jsonb_build_object('version',node.version,'source',admitted));
 END LOOP;
 RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(collected);
END $$;
REVOKE ALL ON FUNCTION read_admitted_session_context_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_admitted_session_context_dependencies(uuid,text[],uuid[],text[]) TO app_user;
 END IF;
END $$;
COMMIT;
