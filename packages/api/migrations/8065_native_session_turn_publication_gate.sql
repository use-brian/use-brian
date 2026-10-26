BEGIN;
-- Native-only original-turn admission; no row policy or lease lifetime changes.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.lock_native_session_context_publication(uuid,uuid)')
  AND prosecdef AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='66919110c9b401e0e3e52686adc5a1e182bfdcff7a8d132aab237199c8b22a9a') THEN
  RAISE EXCEPTION 'Native publication lock prerequisite changed';END IF;
END $$;
CREATE FUNCTION native_session_turn_publication_allowed(w uuid,s uuid,t uuid,stopped boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_session sessions;
BEGIN
 PERFORM lock_native_session_context_publication(w,s);
 IF t IS NULL OR stopped IS NULL THEN RETURN false;END IF;
 SELECT * INTO current_session FROM sessions WHERE workspace_id=w AND id=s;
 IF NOT FOUND OR current_session.last_turn_lease_token IS DISTINCT FROM t THEN RETURN false;END IF;
 RETURN coalesce(current_session.turn_lease_token=t AND current_session.status='running'
  OR stopped AND current_session.turn_lease_token IS NULL AND current_session.turn_end_reason='stopped_by_user',false);
END $$;
REVOKE ALL ON FUNCTION native_session_turn_publication_allowed(uuid,uuid,uuid,boolean) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION native_session_turn_publication_allowed(uuid,uuid,uuid,boolean) TO app_user;END IF;
END $$;
COMMIT;
