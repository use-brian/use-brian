-- [COMP:api/session-recovery] A fresh private continuation; no historical scope repair.
BEGIN;
CREATE TABLE session_recoveries (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 target_session_id uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
 source_revision text NOT NULL CHECK(source_revision~'^[a-f0-9]{64}$'),
 auth_session_id uuid NOT NULL,
 auth_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,source_session_id),
 CHECK(source_session_id<>target_session_id)
);
ALTER TABLE session_recoveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_recoveries_own ON session_recoveries
 USING(user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL)
 WITH CHECK(user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL);

-- This metadata port deliberately cannot read message, title or state bytes.
-- Its workspace pointer locates an owned legacy source, never its content scope.
CREATE FUNCTION read_native_session_recovery_parent(w uuid,i uuid,device uuid,version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 s record; aid uuid; policy bigint;
BEGIN
 IF actor IS NULL OR device IS NULL OR version IS NULL
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'session_recovery_unavailable' USING ERRCODE='42501';END IF;
 PERFORM id FROM workspaces WHERE id=w FOR UPDATE;
 PERFORM a.id FROM auth_sessions a JOIN users u ON u.id=a.user_id
  WHERE a.id=device AND a.user_id=actor AND a.auth_version=version AND u.auth_version=a.auth_version
   AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() FOR SHARE OF a,u;
 IF NOT FOUND THEN RAISE EXCEPTION 'authenticated_session_required' USING ERRCODE='42501';END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'session_recovery_unavailable' USING ERRCODE='42501';END IF;
 SELECT assistant_id INTO aid FROM sessions WHERE id=i AND user_id=actor AND visibility='personal';
 PERFORM id FROM assistants WHERE id=aid AND workspace_id=w FOR SHARE;
 IF NOT FOUND OR assistant_placement_visible(actor,aid) IS NOT TRUE THEN
  RAISE EXCEPTION 'session_recovery_unavailable' USING ERRCODE='42501';END IF;
 SELECT id,assistant_id,workspace_id,mode,anchor_kind,context_compartments,context_binding_origin,
  context_group_id,context_project_id,effective_clearance,channel_type,channel_id,app_origin,status,turn_lease_token
  INTO s FROM sessions WHERE id=i AND user_id=actor AND visibility='personal'
  AND assistant_id=aid AND (workspace_id IS NULL OR workspace_id=w) FOR UPDATE;
 IF NOT FOUND OR s.mode IS NOT NULL OR s.anchor_kind NOT IN('none','inbox','channel')
  OR s.context_compartments IS NULL OR s.context_binding_origin='held'
  OR session_recording_read_allowed(s.id) IS NOT TRUE
  OR personal_web_session_scope_allows(w,actor,aid,s.context_group_id,s.context_project_id,s.context_compartments) IS NOT TRUE
 THEN RAISE EXCEPTION 'session_recovery_unavailable' USING ERRCODE='42501';END IF;
 SELECT revision INTO policy FROM workspace_access_policies WHERE workspace_id=w FOR SHARE;
 RETURN jsonb_build_object('sessionId',s.id,'workspaceId',w,'assistantId',s.assistant_id,
  'storedWorkspaceId',s.workspace_id,'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,
  'contextCompartments',s.context_compartments,'effectiveClearance',s.effective_clearance,
  'contextBindingOrigin',s.context_binding_origin,'channelType',s.channel_type,'channelId',s.channel_id,
  'appOrigin',s.app_origin,'status',s.status,'hasLease',s.turn_lease_token IS NOT NULL,
  'policyRevision',policy::text);
END $$;
REVOKE ALL ON FUNCTION read_native_session_recovery_parent(uuid,uuid,uuid,integer) FROM PUBLIC;

CREATE FUNCTION guard_private_session_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb; target record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'session_recovery_immutable' USING ERRCODE='22023';END IF;
 source:=read_native_session_recovery_parent(NEW.workspace_id,NEW.source_session_id,NEW.auth_session_id,NEW.auth_version);
 IF source->>'status'='running' OR (source->>'hasLease')::boolean THEN
  RAISE EXCEPTION 'session_recovery_busy' USING ERRCODE='40001';END IF;
 SELECT id,user_id,workspace_id,visibility,channel_type,app_origin,anchor_kind,mode,assistant_id,
  context_group_id,context_project_id,context_compartments INTO target
  FROM sessions WHERE id=NEW.target_session_id FOR SHARE;
 IF NOT FOUND OR NEW.user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
  OR target.user_id<>NEW.user_id OR target.workspace_id IS DISTINCT FROM NEW.workspace_id
  OR target.visibility<>'personal' OR target.channel_type<>'web' OR target.app_origin IS DISTINCT FROM 'chat'
  OR target.anchor_kind<>'none' OR target.mode IS NOT NULL
  OR target.assistant_id IS DISTINCT FROM (source->>'assistantId')::uuid
  OR target.context_group_id IS DISTINCT FROM (source->>'contextGroupId')::uuid
  OR target.context_project_id IS DISTINCT FROM (source->>'contextProjectId')::uuid
  OR to_jsonb(target.context_compartments) IS DISTINCT FROM source->'contextCompartments'
  OR session_recording_read_allowed(target.id) IS NOT TRUE
 THEN RAISE EXCEPTION 'session_recovery_unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_private_session_recovery() FROM PUBLIC;
CREATE TRIGGER session_recoveries_immutable BEFORE INSERT OR UPDATE ON session_recoveries
 FOR EACH ROW EXECUTE FUNCTION guard_private_session_recovery();
REVOKE ALL ON session_recoveries FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT SELECT,INSERT ON session_recoveries TO app_user;
 REVOKE UPDATE,DELETE ON session_recoveries FROM app_user;
 GRANT EXECUTE ON FUNCTION read_native_session_recovery_parent(uuid,uuid,uuid,integer) TO app_user;
END IF;END $$;
COMMIT;
