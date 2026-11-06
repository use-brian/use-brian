-- [COMP:api/private-transcript] Resume the original private session without rewriting historical messages.
BEGIN;
CREATE FUNCTION resume_private_legacy_session(w uuid,i uuid,device uuid,version integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s sessions;receipt session_legacy_history;
BEGIN
 -- The existing native port authenticates the actual runtime role, device,
 -- recorded owner, membership, assistant, context and recording privacy.
 PERFORM private_session_display_parent(w,i,device,version);
 SELECT * INTO s FROM sessions WHERE id=i FOR UPDATE;
 IF s.workspace_id IS NOT NULL THEN RETURN false;END IF;
 IF s.channel_type<>'web' OR coalesce(s.app_origin,'chat')<>'chat' OR s.anchor_kind<>'none' OR s.mode IS NOT NULL
 THEN RETURN false;END IF;
 SELECT * INTO receipt FROM session_legacy_history WHERE session_id=i AND workspace_id=w AND user_id=s.user_id FOR UPDATE;
 IF NOT FOUND OR receipt.binding IS DISTINCT FROM private_legacy_history_binding(s)
  OR scope_review_state_held('session',i) IS TRUE THEN RETURN false;END IF;
 -- Only the already-authenticated parent receives its missing workspace.
 -- Frozen row fingerprints, scope labels and all message bytes stay intact.
 UPDATE sessions SET workspace_id=w WHERE id=i RETURNING * INTO s;
 UPDATE session_legacy_history SET binding=private_legacy_history_binding(s) WHERE session_id=i;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION resume_private_legacy_session(uuid,uuid,uuid,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION resume_private_legacy_session(uuid,uuid,uuid,integer) TO app_user;END IF;END $$;

-- A resumed session keeps its frozen pre-upgrade cohort alongside new scoped
-- turns. The cohort's own reader still checks exact original row fingerprints.
DO $$ DECLARE definition text;before text:='s.workspace_id IS NULL';BEGIN
 definition:=pg_get_functiondef('capture_private_transcript(uuid,uuid,uuid,integer,integer)'::regprocedure);
 IF (length(definition)-length(replace(definition,before,'')))/length(before)<>2
 THEN RAISE EXCEPTION 'private_transcript_legacy_capture_shape_changed';END IF;
 EXECUTE replace(definition,before,'EXISTS(SELECT 1 FROM session_legacy_history WHERE session_id=i AND workspace_id=w)');
END $$;
COMMIT;
