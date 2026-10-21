BEGIN;
-- Preserve every current native parent gate; resolve only a personal session's
-- intentionally dynamic classification from actual current authority rows.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.session_context_parent_snapshot(uuid,uuid)')
  AND prosecdef AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='908e0af94d168f44d77e8cb9eb30e73d3317dfc71896b7b39e28e1a6f2139444') THEN
  RAISE EXCEPTION 'Native personal session prerequisite changed';END IF;
END $$;
CREATE OR REPLACE FUNCTION session_context_parent_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s sessions;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 live_floor text;invocation_floor text:=nullif(current_setting('app.agent_clearance',true),'');
BEGIN
 -- There is no application data grant for a raw native session. A canonical
 -- application-session port must be integrated before that lane is available.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
    OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN RETURN NULL;END IF;
 SELECT * INTO s FROM sessions WHERE workspace_id=w AND id=i FOR SHARE;
 IF NOT FOUND OR NOT coalesce(session_personal_audience(s) OR session_workspace_audience(s),false)
  OR session_project_audience(s,false) IS NOT TRUE THEN RETURN NULL;END IF;
 -- Personal sessions inherit a current, persisted assistant/member ceiling.
 -- Shared/legacy unclassified rows remain held. The GUC can only narrow the
 -- real ceiling; it never supplies authority or a missing canonical label.
 live_floor:=s.effective_clearance;
 IF live_floor IS NULL AND s.visibility='personal' THEN
  SELECT CASE WHEN sensitivity_rank(a.clearance)<=sensitivity_rank(wm.clearance) THEN a.clearance ELSE wm.clearance END
   INTO live_floor FROM assistants a JOIN workspace_members wm ON wm.workspace_id=a.workspace_id
   WHERE a.workspace_id=w AND a.id=coalesce(acting,s.assistant_id) AND wm.user_id=actor;
  IF live_floor NOT IN('public','internal','confidential') OR live_floor IS NULL THEN RETURN NULL;END IF;
  IF invocation_floor IS NOT NULL THEN
   IF invocation_floor NOT IN('public','internal','confidential') THEN RETURN NULL;END IF;
   IF sensitivity_rank(invocation_floor)<sensitivity_rank(live_floor) THEN live_floor:=invocation_floor;END IF;
  END IF;
 END IF;
 IF live_floor IS NULL OR s.context_compartments IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('workspaceId',w,'userId',CASE WHEN s.visibility='personal' THEN s.user_id ELSE NULL END,
  'assistantId',NULL,'sensitivity',live_floor,'compartments',s.context_compartments,
  'projectIds',CASE WHEN s.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(s.context_project_id) END,
  'assistant',s.assistant_id,'createdBy',s.user_id);
END $$;
REVOKE ALL ON FUNCTION session_context_parent_snapshot(uuid,uuid) FROM PUBLIC;
-- Preserve the originating token after an explicit stop releases the slot.
-- A later claimant replaces it even if that claimant has already finished.
ALTER TABLE sessions ADD COLUMN last_turn_lease_token uuid;
CREATE FUNCTION remember_native_session_turn_lease() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.last_turn_lease_token:=NEW.turn_lease_token;
 ELSIF NEW.turn_lease_token IS NOT NULL AND NEW.turn_lease_token IS DISTINCT FROM OLD.turn_lease_token THEN
  NEW.last_turn_lease_token:=NEW.turn_lease_token;
 ELSE NEW.last_turn_lease_token:=OLD.last_turn_lease_token;END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION remember_native_session_turn_lease() FROM PUBLIC;
CREATE TRIGGER remember_native_session_turn_lease BEFORE INSERT OR UPDATE OF turn_lease_token,last_turn_lease_token ON sessions
 FOR EACH ROW EXECUTE FUNCTION remember_native_session_turn_lease();
COMMIT;
