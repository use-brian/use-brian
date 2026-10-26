-- Spec: docs/architecture/features/goals.md -> Portable native authentication
-- [COMP:api/task-responsibility] Exact original credentials, never a fresh viewer credential.
BEGIN;
CREATE FUNCTION retained_native_auth_session_current(actor uuid,credential jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF actor IS NULL OR jsonb_typeof(credential) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(credential))<>3
  OR credential->>'userId' IS DISTINCT FROM actor::text
  OR jsonb_typeof(credential->'sessionId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(credential->'authVersion') IS DISTINCT FROM 'number'
  OR credential->>'authVersion' !~ '^[0-9]+$' THEN RETURN false;END IF;
 PERFORM 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
 WHERE s.id=(credential->>'sessionId')::uuid AND s.user_id=actor
  AND s.auth_version=(credential->>'authVersion')::integer AND u.auth_version=s.auth_version
  AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF s,u;
 RETURN FOUND;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION retained_native_auth_session_current(uuid,jsonb) FROM PUBLIC;
DO $migration$ DECLARE definition text;anchor text;replacement text;BEGIN
 definition:=pg_get_functiondef('public.retained_task_goal_source_current(uuid,boolean)'::regprocedure);
 anchor:=$anchor$ w:=saved.workspace_id;origin:=saved.proof->'retained'->'sourceAuthority';$anchor$;
 replacement:=anchor||$replacement$
 IF origin ? 'nativeCredential' AND retained_native_auth_session_current(actor,origin->'nativeCredential') IS NOT TRUE THEN RETURN false;END IF;$replacement$;
 IF (length(definition)-length(replace(definition,anchor,'')))<>length(anchor)
  OR position('retained_native_auth_session_current(' IN definition)>0 THEN
  RAISE EXCEPTION 'retained_goal_authentication_definition_unavailable';END IF;
 EXECUTE replace(definition,anchor,replacement);
END $migration$;
COMMIT;
