BEGIN;
-- Explicit native workspace consent. Historical credentials stay NULL.
ALTER TABLE brain_keys ADD COLUMN workspace_mcp_consent jsonb;
ALTER TABLE api_keys ADD COLUMN workspace_mcp_consent jsonb;
CREATE OR REPLACE FUNCTION guard_external_key_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w uuid; ready boolean; session uuid; actor uuid; reach text[]; team text;
BEGIN
 IF TG_TABLE_NAME='brain_keys' THEN w:=NEW.workspace_id;
 ELSE SELECT workspace_id INTO w FROM assistants WHERE id=NEW.assistant_id; END IF;
 SELECT setup_state<>'legacy' INTO ready FROM workspace_access_policies WHERE workspace_id=w;
 -- Mixed writers that already locked a key fail rather than deadlock against
 -- canonical workspace-first writers. A legacy update (revoke, last-used
 -- touch, clearance cap) never waited on the workspace before the access-mode
 -- branch and must not start failing on it (permission-model-v2 §12.3 item 4);
 -- inserts come from createExternalKey, which already holds the lock.
 IF coalesce(ready,false) OR TG_OP='INSERT' THEN
  PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE NOWAIT;
 END IF;
 IF NEW.workspace_mcp_consent IS NOT NULL THEN
  -- Explicit workspace profiles are new consent, never an upgrade of an old key.
  IF TG_OP='UPDATE' THEN
   IF OLD.workspace_mcp_consent IS NULL OR (to_jsonb(NEW)-'status'-'last_used_at'-'key_hash'-'key_prefix')
      IS DISTINCT FROM (to_jsonb(OLD)-'status'-'last_used_at'-'key_hash'-'key_prefix')
     THEN RAISE EXCEPTION 'workspace_mcp_consent_immutable'; END IF;
   IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'revoked'
     THEN RAISE EXCEPTION 'external_key_resume_unsupported'; END IF;
   IF ROW(NEW.key_hash,NEW.key_prefix) IS DISTINCT FROM ROW(OLD.key_hash,OLD.key_prefix)
      AND programmatic_configuration_actor(w,nullif(current_setting('app.current_user_id',true),'')::uuid,
       nullif(current_setting('app.external_key_session',true),'')::uuid) IS NOT TRUE
     THEN RAISE EXCEPTION 'external_key_rotation_denied'; END IF;
   RETURN NEW;
  END IF;
  session:=nullif(current_setting('app.external_key_session',true),'')::uuid;
  actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  IF programmatic_configuration_actor(w,actor,session) IS NOT TRUE OR NEW.created_by IS DISTINCT FROM actor
    THEN RAISE EXCEPTION 'workspace_mcp_native_consent_required'; END IF;
  IF NEW.workspace_mcp_consent->>'version' IS DISTINCT FROM '1'
    OR jsonb_typeof(NEW.workspace_mcp_consent->'operationNames') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.workspace_mcp_consent->'compartments') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.workspace_mcp_consent->'mutationCompartments') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.workspace_mcp_consent->'projectIds') IS DISTINCT FROM 'array'
    OR NEW.workspace_mcp_consent->>'maxClearance' IS NULL
    OR NEW.workspace_mcp_consent->>'expiresAt' IS NULL
    OR NEW.workspace_mcp_consent->>'maxClearance' NOT IN ('public','internal','confidential')
    OR (NEW.workspace_mcp_consent->>'expiresAt')::timestamptz <= clock_timestamp()
    OR (NEW.workspace_mcp_consent->>'expiresAt')::timestamptz > clock_timestamp()+interval '90 days 1 minute'
    OR jsonb_array_length(NEW.workspace_mcp_consent->'operationNames')>4096
    THEN RAISE EXCEPTION 'workspace_mcp_consent_invalid'; END IF;
  IF NOT EXISTS(SELECT 1 FROM assistants a WHERE a.id=(NEW.workspace_mcp_consent->>'assistantId')::uuid
    AND a.workspace_id=w AND (TG_TABLE_NAME='api_keys' OR a.kind='primary'))
    THEN RAISE EXCEPTION 'workspace_mcp_assistant_unavailable'; END IF;
  IF TG_TABLE_NAME='api_keys' THEN
   IF NEW.scope<>'agent' OR NEW.tool_policy<>'assistant'
     OR NEW.assistant_id IS DISTINCT FROM (NEW.workspace_mcp_consent->>'assistantId')::uuid
     THEN RAISE EXCEPTION 'workspace_mcp_consent_invalid'; END IF;
  END IF;
  reach:=effective_member_team_compartments(actor,w);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.workspace_mcp_consent->'compartments') c
    WHERE reach IS NOT NULL AND NOT c=ANY(reach))
    OR NOT ((NEW.workspace_mcp_consent->'compartments') @> (NEW.workspace_mcp_consent->'mutationCompartments'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.workspace_mcp_consent->'projectIds') p
      WHERE NOT EXISTS(SELECT 1 FROM workspace_projects x WHERE x.id=p::uuid AND x.workspace_id=w AND x.status='active'))
    THEN RAISE EXCEPTION 'workspace_mcp_scope_unavailable'; END IF;
  IF TG_TABLE_NAME='brain_keys' THEN
   IF NEW.context_group_id IS DISTINCT FROM (NEW.workspace_mcp_consent->>'contextGroupId')::uuid
      OR NEW.context_project_id IS DISTINCT FROM (NEW.workspace_mcp_consent->>'contextProjectId')::uuid
      THEN RAISE EXCEPTION 'workspace_mcp_consent_invalid'; END IF;
   NEW.admitted_compartments:=ARRAY(SELECT jsonb_array_elements_text(NEW.workspace_mcp_consent->'compartments'));
   NEW.admitted_project_ids:=ARRAY(SELECT jsonb_array_elements_text(NEW.workspace_mcp_consent->'projectIds')::uuid);
   NEW.configuration_session_id:=session;
   NEW.context_binding_origin:='reviewed';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.workspace_mcp_consent IS NOT NULL THEN
  RAISE EXCEPTION 'workspace_mcp_consent_immutable';
 END IF;
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

ALTER FUNCTION external_brain_key_current(uuid) RENAME TO external_brain_key_current_before_workspace_mcp;
CREATE FUNCTION external_brain_key_current(kid uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN k.workspace_mcp_consent IS NULL THEN external_brain_key_current_before_workspace_mcp(kid)
 ELSE k.status='active' AND (k.workspace_mcp_consent->>'expiresAt')::timestamptz>clock_timestamp()
   AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id)
   AND EXISTS(SELECT 1 FROM assistants a WHERE a.id=(k.workspace_mcp_consent->>'assistantId')::uuid
    AND a.workspace_id=k.workspace_id AND a.kind='primary') END
 FROM brain_keys k WHERE k.id=kid
$$;
COMMIT;
