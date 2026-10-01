BEGIN;
-- Bounded first lane: explicit Team-bound Brain credentials. No member/default
-- admission and no reinterpretation/backfill of historical null bindings.
ALTER TABLE brain_keys ADD COLUMN configuration_session_id uuid REFERENCES auth_sessions(id);
ALTER TABLE brain_keys ADD COLUMN admitted_compartments text[];
ALTER TABLE brain_keys ADD COLUMN admitted_project_ids uuid[];
CREATE FUNCTION external_brain_key_current(kid uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT k.status='active' AND (k.configuration_session_id IS NULL OR EXISTS (
 SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
 JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=k.workspace_id
 JOIN workspace_groups g ON g.id=k.context_group_id AND g.workspace_id=k.workspace_id
 WHERE s.id=k.configuration_session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND s.auth_version=u.auth_version AND m.role IN ('owner','admin') AND g.status='active'
 AND k.context_binding_origin='reviewed' AND k.admitted_compartments=ARRAY[g.compartment_key]
 AND (k.context_project_id IS NULL OR EXISTS(SELECT 1 FROM workspace_projects p
 WHERE p.id=k.context_project_id AND p.workspace_id=k.workspace_id AND p.status='active'))
 AND (effective_member_team_compartments(u.id,k.workspace_id) IS NULL
 OR g.compartment_key=ANY(effective_member_team_compartments(u.id,k.workspace_id)))))
 FROM brain_keys k WHERE k.id=kid
$$;
CREATE FUNCTION guard_external_key_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w uuid; ready boolean; session uuid; actor uuid; reach text[]; team text;
BEGIN
 IF TG_TABLE_NAME='brain_keys' THEN w:=NEW.workspace_id;
 ELSE SELECT workspace_id INTO w FROM assistants WHERE id=NEW.assistant_id; END IF;
 -- Mixed writers that already locked a key fail rather than deadlock against
 -- canonical workspace-first writers.
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE NOWAIT;
 SELECT setup_state<>'legacy' INTO ready FROM workspace_access_policies WHERE workspace_id=w;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='api_keys' THEN
   -- No finite assistant-key admission exists yet. Preserve existing keys,
   -- not a route for importing/rebinding authority into ready workspaces.
   -- An allowlist also covers future authority columns. This is identical
   -- in legacy and ready modes: key purpose/audience remain issuance facts.
   IF (to_jsonb(NEW)-'status'-'last_used_at') IS DISTINCT FROM
      (to_jsonb(OLD)-'status'-'last_used_at')
    THEN RAISE EXCEPTION 'external_key_api_binding_unsupported'; END IF;
   IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'revoked'
    THEN RAISE EXCEPTION 'external_key_resume_unsupported'; END IF;
   RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='brain_keys' THEN
   IF (ready OR OLD.configuration_session_id IS NOT NULL) AND
    ROW(NEW.workspace_id,NEW.context_group_id,NEW.context_project_id,NEW.configuration_session_id,NEW.max_clearance,NEW.context_binding_origin,NEW.admitted_compartments,NEW.admitted_project_ids,NEW.scope)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.context_group_id,OLD.context_project_id,OLD.configuration_session_id,OLD.max_clearance,OLD.context_binding_origin,OLD.admitted_compartments,OLD.admitted_project_ids,OLD.scope)
    THEN RAISE EXCEPTION 'external_key_rebind_unsupported'; END IF;
   IF NEW.key_hash IS DISTINCT FROM OLD.key_hash THEN
    IF programmatic_configuration_actor(w,nullif(current_setting('app.current_user_id',true),'')::uuid,
      nullif(current_setting('app.external_key_session',true),'')::uuid) IS NOT TRUE
      OR external_brain_key_current(OLD.id) IS NOT TRUE THEN RAISE EXCEPTION 'external_key_rotation_denied'; END IF;
   END IF;
   IF OLD.status='revoked' AND NEW.status<>'revoked' THEN RAISE EXCEPTION 'external_key_resume_unsupported'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NOT coalesce(ready,false) THEN RETURN NEW; END IF;
 -- Assistant/API scope has no finite persisted context ceiling yet. Do not
 -- pretend that assistant defaults or Simple constitute such a ceiling.
 IF TG_TABLE_NAME='api_keys' THEN RAISE EXCEPTION 'external_key_api_binding_unsupported'; END IF;
 session:=nullif(current_setting('app.external_key_session',true),'')::uuid;
 actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 IF programmatic_configuration_actor(w,actor,session) IS NOT TRUE
 OR current_setting('app.external_key_explicit',true) IS DISTINCT FROM 'true'
 OR NEW.context_group_id IS NULL OR NEW.max_clearance IS NULL
 THEN RAISE EXCEPTION 'external_key_review_required'; END IF;
 SELECT compartment_key INTO team FROM workspace_groups WHERE id=NEW.context_group_id AND workspace_id=w AND kind='team' AND status='active';
 reach:=effective_member_team_compartments(actor,w);
 IF team IS NULL OR (reach IS NOT NULL AND NOT team=ANY(reach)) THEN RAISE EXCEPTION 'external_key_binding_unavailable'; END IF;
 IF NEW.context_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_projects
 WHERE id=NEW.context_project_id AND workspace_id=w AND status='active') THEN RAISE EXCEPTION 'external_key_project_unavailable'; END IF;
 NEW.admitted_compartments:=ARRAY[team];
 NEW.admitted_project_ids:=CASE WHEN NEW.context_project_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[NEW.context_project_id] END;
 NEW.configuration_session_id:=session;
 NEW.context_binding_origin:='reviewed';
 RETURN NEW;
END $$;
CREATE TRIGGER external_key_admission BEFORE INSERT OR UPDATE ON brain_keys FOR EACH ROW EXECUTE FUNCTION guard_external_key_admission();
CREATE TRIGGER external_key_admission BEFORE INSERT OR UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION guard_external_key_admission();
-- Capture shares the live principal gate; retain 641's source proof unchanged.
ALTER FUNCTION programmatic_intake_current(uuid,uuid,uuid,jsonb) RENAME TO programmatic_intake_current_before_external_keys;
CREATE FUNCTION programmatic_intake_current(w uuid,a uuid,r uuid,ev jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN ev->>'principalKind'='api_key' AND external_brain_key_current((ev->>'principalId')::uuid) IS TRUE
 THEN programmatic_intake_current_before_external_keys(w,a,r,ev) ELSE false END
$$;
COMMIT;
