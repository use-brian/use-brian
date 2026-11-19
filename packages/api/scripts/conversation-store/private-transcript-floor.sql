
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 s record; aid uuid; policy bigint;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; floor_assistant uuid;
BEGIN
 IF actor IS NULL OR device IS NULL OR version IS NULL
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'session_recovery_unavailable' USING ERRCODE='42501';END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
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
 -- The scope floor belongs to the assistant that actually reads: the session's
 -- bound assistant, or the answering assistant pinned for this native operation.
 -- Its own clearance and assignment are the conservative input floor; every
 -- row is still admitted individually under that assistant's current ceiling.
 floor_assistant:=aid;
 IF acting IS NOT NULL AND acting IS DISTINCT FROM aid THEN
  PERFORM id FROM assistants WHERE id=acting AND workspace_id=w FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN
   RAISE EXCEPTION 'session_recovery_unavailable' USING ERRCODE='42501';END IF;
  floor_assistant:=acting;
 END IF;
 SELECT id,assistant_id,workspace_id,mode,anchor_kind,context_compartments,context_binding_origin,
  context_group_id,context_project_id,effective_clearance,channel_type,channel_id,app_origin,status,turn_lease_token
  INTO s FROM sessions WHERE id=i AND user_id=actor AND visibility='personal'
  AND assistant_id=aid AND (workspace_id IS NULL OR workspace_id=w) FOR SHARE;
 IF NOT FOUND OR s.mode IS NOT NULL OR s.anchor_kind NOT IN('none','inbox','channel')
  OR s.context_compartments IS NULL OR s.context_binding_origin='held'
  OR session_recording_read_allowed(s.id) IS NOT TRUE
  OR personal_web_session_scope_allows(w,actor,floor_assistant,s.context_group_id,s.context_project_id,s.context_compartments) IS NOT TRUE
 THEN RAISE EXCEPTION 'session_recovery_unavailable' USING ERRCODE='42501';END IF;
 SELECT revision INTO policy FROM workspace_access_policies WHERE workspace_id=w FOR SHARE;
 RETURN jsonb_build_object('sessionId',s.id,'workspaceId',w,'assistantId',s.assistant_id,
  'storedWorkspaceId',s.workspace_id,'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,
  'contextCompartments',s.context_compartments,'effectiveClearance',s.effective_clearance,
  'contextBindingOrigin',s.context_binding_origin,'channelType',s.channel_type,'channelId',s.channel_id,
  'appOrigin',s.app_origin,'status',s.status,'hasLease',s.turn_lease_token IS NOT NULL,
  'policyRevision',policy::text);
END 
