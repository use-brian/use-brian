-- [COMP:api/conversation-visibility] Hold the addressed provider record for
-- one append. The provider ingress remains the credential owner. The native
-- app caller also proves its original current member and exact turn lease.
CREATE FUNCTION public.pin_verified_channel_conversation_append(w uuid,sid uuid,actor uuid,responder uuid,
 transport text,address text,member_actor boolean,room boolean,expected_version bigint,lease uuid,integration uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $channel_append$
DECLARE s public.sessions;e public.conversation_envelopes;owns_tables boolean;bound_channel uuid;parent_address text;
BEGIN
 SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND r.oid=c.relowner INTO owns_tables
  FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass WHERE r.rolname=session_user;
 IF num_nulls(w,sid,actor,responder,transport,address,member_actor,room,expected_version,lease)<>0
  OR transport NOT IN('telegram','slack','discord','feishu','msteams','whatsapp','wechat','email','custom','imessage')
  OR length(address) NOT BETWEEN 1 AND 1000 OR expected_version<1
  OR owns_tables IS NOT TRUE AND (session_user<>'app_user' OR member_actor IS NOT TRUE
   OR actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
   OR nullif(current_setting('app.application_id',true),'') IS NOT NULL)
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
 PERFORM id FROM public.assistants WHERE id=responder AND workspace_id=w FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 PERFORM id FROM public.users WHERE id=actor FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF FOUND IS DISTINCT FROM member_actor THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 IF integration IS NOT NULL THEN
  SELECT c.id INTO bound_channel FROM public.channel_integrations ci JOIN public.channels c ON c.id=ci.channel_id
   WHERE ci.id=integration AND ci.channel_type=transport AND c.workspace_id=w AND ci.status='active' AND c.status='active'
   FOR UPDATE OF c FOR SHARE OF ci;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
  parent_address:=CASE WHEN transport='telegram' THEN regexp_replace(address,'^(\-?[0-9]+):(topic|discussion):[0-9]+$','\1')
   WHEN transport IN('slack','feishu') THEN split_part(address,':thread:',1) ELSE address END;
  IF (SELECT ca.assistant_id FROM public.channel_assistants ca WHERE ca.channel_id=bound_channel
   AND (ca.external_surface_id IS NULL OR ca.external_surface_id IN(address,parent_address))
   ORDER BY CASE WHEN ca.external_surface_id=address THEN 0 WHEN ca.external_surface_id=parent_address THEN 1 ELSE 2 END
   LIMIT 1 FOR SHARE) IS DISTINCT FROM responder
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 END IF;
 SELECT * INTO s FROM public.sessions WHERE id=sid AND (workspace_id IS NULL OR workspace_id=w) FOR UPDATE;
 IF NOT FOUND OR s.channel_type<>transport OR s.channel_id<>address OR s.archived_at IS NOT NULL
  OR s.recording_privacy_held IS TRUE OR public.scope_review_state_held('session',sid)
  OR s.turn_lease_token IS DISTINCT FROM lease OR s.last_turn_lease_token IS DISTINCT FROM lease OR s.status<>'running'
  OR s.cancel_requested_at IS NOT NULL OR s.turn_heartbeat_at IS NULL
  OR s.turn_heartbeat_at<=clock_timestamp()-interval '90 seconds'
  OR coalesce(s.turn_assistant_id,s.assistant_id)<>responder
  OR NOT (room AND s.anchor_kind='channel' OR NOT room AND s.anchor_kind='none' AND s.user_id=actor AND s.assistant_id=responder)
  OR s.provider_context_identity IS NOT NULL AND s.provider_context_identity->>'integrationId' IS DISTINCT FROM integration::text
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id=w FOR UPDATE;
 IF NOT FOUND OR e.starter_user_id<>s.user_id OR e.version<>expected_version OR room AND e.visibility<>'workspace'
  OR member_actor AND public.conversation_member_read_allowed(w,sid,actor) IS NOT TRUE
  OR NOT member_actor AND (e.visibility<>'workspace' OR NOT room AND (e.cap<>'public'
   OR cardinality(e.compartments)<>0 OR e.classification<>'new_public'))
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('version',e.version::text,'visibility',e.visibility,'cap',e.cap,'compartments',e.compartments,
  'projects',public.conversation_hard_project_ids(e.compartments));
END $channel_append$;
REVOKE ALL ON FUNCTION public.pin_verified_channel_conversation_append(uuid,uuid,uuid,uuid,text,text,boolean,boolean,bigint,uuid,uuid)
 FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.pin_verified_channel_conversation_append(uuid,uuid,uuid,uuid,text,text,boolean,boolean,bigint,uuid,uuid)
 TO app_user;
