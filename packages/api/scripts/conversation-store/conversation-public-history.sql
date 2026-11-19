-- [COMP:api/conversation-visibility] Bind the addressed public conversation
-- to the exact credential verified by its HTTP owner. Returning an envelope
-- pins this operation, never authority across later operations.
CREATE FUNCTION public.public_conversation_session_current(
 target_assistant uuid, credential jsonb, attributed_actor uuid,
 visitor text, channel text, expected_session uuid DEFAULT NULL,
 expected_actor uuid DEFAULT NULL, claimed_email text DEFAULT NULL,
 expected_version bigint DEFAULT NULL, write_lock boolean DEFAULT false,
 expected_lease uuid DEFAULT NULL, pin_facts boolean DEFAULT true
) RETURNS public.conversation_envelopes
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $public_session$
DECLARE
 key_id uuid:=(credential->>'id')::uuid;
 kind text:=credential->>'kind';
 fingerprint text:=credential->>'fingerprint';
 a public.assistants;
 s public.sessions;
 e public.conversation_envelopes;
 actor uuid;
 w uuid;
 namespace text;
 original_cap text;
 scoped_member boolean:=attributed_actor IS NOT NULL;
BEGIN
 IF key_id IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$'
  OR visitor IS NULL OR length(visitor) NOT BETWEEN 1 AND 256
  OR channel IS NULL OR length(channel) NOT BETWEEN 1 AND 256
  OR write_lock IS NULL OR pin_facts IS NULL OR (write_lock AND (expected_session IS NULL OR expected_actor IS NULL
   OR expected_version IS NULL OR expected_lease IS NULL OR NOT pin_facts))
  OR (NOT pin_facts AND (expected_session IS NULL OR expected_version IS NULL))
  OR (expected_session IS NULL AND (expected_actor IS NOT NULL OR claimed_email IS NOT NULL OR expected_version IS NOT NULL))
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 SELECT assistant.workspace_id INTO w FROM public.assistants assistant WHERE id=target_assistant;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 IF w IS NOT NULL THEN
  IF pin_facts THEN PERFORM id FROM public.workspaces WHERE id=w FOR SHARE; END IF;
  PERFORM id FROM public.workspaces WHERE id=w
   AND (kind IS DISTINCT FROM 'chat_link' OR external_sharing_enabled);
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 END IF;
 IF pin_facts THEN PERFORM id FROM public.assistants WHERE id=target_assistant FOR SHARE; END IF;
 SELECT * INTO a FROM public.assistants WHERE id=target_assistant AND workspace_id IS NOT DISTINCT FROM w;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 CASE kind
 WHEN 'chat_link' THEN
  IF attributed_actor IS NOT NULL OR claimed_email IS NOT NULL OR a.placement_department_id IS NOT NULL THEN
   RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
  IF pin_facts THEN PERFORM id FROM public.assistant_chat_links WHERE id=key_id AND assistant_id=target_assistant FOR SHARE; END IF;
  PERFORM id FROM public.assistant_chat_links
   WHERE id=key_id AND assistant_id=target_assistant AND status='active'
   AND encode(sha256(convert_to(token,'UTF8')),'hex')=fingerprint;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
  namespace:='chatlink:'||key_id;
 WHEN 'api_key' THEN
  IF pin_facts THEN PERFORM id FROM public.api_keys WHERE id=key_id AND assistant_id=target_assistant FOR SHARE; END IF;
  PERFORM id FROM public.api_keys
   WHERE id=key_id AND assistant_id=target_assistant AND status='active'
   AND workspace_mcp_consent IS NULL
   AND audience=CASE WHEN attributed_actor IS NULL THEN 'external' ELSE 'internal' END
   AND jsonb_build_object('scope',scope,'audience',audience,'anonymousContext',anonymous_context,
    'toolPolicy',tool_policy,'createdBy',created_by)=credential->'configuration'
   AND encode(sha256(convert_to(key_hash,'UTF8')),'hex')=fingerprint;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
  namespace:='api:'||key_id;
 ELSE RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';
 END CASE;

 IF attributed_actor IS NOT NULL THEN
  IF pin_facts THEN PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=attributed_actor FOR SHARE; END IF;
  SELECT user_id INTO actor FROM public.workspace_members WHERE workspace_id=w AND user_id=attributed_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 ELSE
  IF pin_facts THEN PERFORM id FROM public.users WHERE auth_provider='channel' AND auth_provider_id=namespace||':'||visitor FOR SHARE; END IF;
  SELECT id INTO actor FROM public.users WHERE auth_provider='channel' AND auth_provider_id=namespace||':'||visitor
   AND (expected_actor IS NULL OR id=expected_actor);
  IF actor IS NULL AND claimed_email IS NOT NULL AND expected_actor IS NOT NULL THEN
   IF pin_facts THEN
    PERFORM id FROM public.users WHERE id=expected_actor FOR SHARE;
    PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=expected_actor FOR SHARE;
   END IF;
   SELECT id INTO actor FROM public.users
    WHERE id=expected_actor AND lower(email)=lower(claimed_email);
   scoped_member:=EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=w AND user_id=actor);
  END IF;
  IF actor IS NULL AND expected_session IS NULL THEN RETURN NULL; END IF;
 END IF;
 IF expected_actor IS NOT NULL AND actor IS DISTINCT FROM expected_actor THEN
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 IF write_lock THEN
  PERFORM id FROM public.sessions WHERE id=expected_session AND assistant_id=target_assistant AND user_id=actor FOR NO KEY UPDATE;
 END IF;
 SELECT * INTO s FROM public.sessions WHERE assistant_id=target_assistant AND user_id=actor
  AND channel_type='api' AND channel_id=channel AND app_id='Use Brian' AND visibility='personal'
  AND anchor_kind='none' AND (workspace_id=w OR workspace_id IS NULL)
  AND (expected_session IS NULL OR id=expected_session);
 IF NOT FOUND THEN
  IF expected_session IS NULL THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';
 END IF;
 IF pin_facts AND NOT write_lock THEN
  PERFORM id FROM public.sessions current_session WHERE current_session.id=s.id
   AND ROW(current_session.assistant_id,current_session.user_id,current_session.channel_type,current_session.channel_id,
   current_session.app_id,current_session.visibility,current_session.anchor_kind,current_session.workspace_id)
   IS NOT DISTINCT FROM ROW(s.assistant_id,s.user_id,s.channel_type,s.channel_id,s.app_id,s.visibility,s.anchor_kind,s.workspace_id)
   FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 END IF;
 IF expected_lease IS NOT NULL AND (s.last_turn_lease_token IS DISTINCT FROM expected_lease
  OR s.turn_lease_token IS DISTINCT FROM expected_lease OR s.status<>'running' OR s.cancel_requested_at IS NOT NULL
  OR s.turn_heartbeat_at IS NULL OR s.turn_heartbeat_at<=clock_timestamp()-interval '90 seconds')
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 -- Classify at most the exactly addressed legacy session. No user, session, or
 -- message is created by this GET. The actor and protected binding are pinned.
 IF pin_facts AND NOT EXISTS(SELECT 1 FROM public.conversation_envelopes WHERE session_id=s.id) THEN
  PERFORM public.classify_conversation_envelope(s.id,true);
 END IF;
 IF write_lock THEN
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=s.id AND workspace_id IS NOT DISTINCT FROM w FOR UPDATE;
 ELSIF pin_facts THEN
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=s.id AND workspace_id IS NOT DISTINCT FROM w FOR SHARE;
 ELSE
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=s.id AND workspace_id IS NOT DISTINCT FROM w;
 END IF;
 IF e.session_id IS NULL OR e.starter_user_id IS DISTINCT FROM actor
  OR expected_version IS NOT NULL AND e.version IS DISTINCT FROM expected_version
  OR expected_session IS NOT NULL AND public.sensitivity_rank(a.clearance)<public.sensitivity_rank(e.cap)
  OR NOT public.session_recording_read_allowed(s.id)
  OR public.scope_review_state_held('session',s.id) THEN
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 IF scoped_member THEN
  IF public.conversation_member_read_allowed(w,s.id,actor) IS NOT TRUE THEN
   RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 ELSIF w IS NOT NULL THEN
  -- A visitor is not a workspace member. Its exact original configured-private
  -- record remains accessible, while a newer room is limited to the public cap.
  SELECT before_envelope->>'cap' INTO original_cap
  FROM public.conversation_visibility_audit WHERE session_id=s.id ORDER BY next_version LIMIT 1;
  IF public.sensitivity_rank(a.clearance)<public.sensitivity_rank(e.cap) OR e.compartments<>'{}'::text[]
   OR NOT (e.visibility IN('configured_private','workspace') AND e.cap='public'
    AND (e.visibility<>'workspace' OR e.classification<>'legacy_personal' OR public.conversation_consent_current(s.id))
    OR e.visibility='configured_private' AND e.classification='legacy_personal'
    AND e.cap IS NOT DISTINCT FROM coalesce(original_cap,e.cap))
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 ELSIF e.visibility='workspace' THEN
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';
 END IF;
 RETURN e;
END $public_session$;
REVOKE ALL ON FUNCTION public.public_conversation_session_current(uuid,jsonb,uuid,text,text,uuid,uuid,text,bigint,boolean,uuid,boolean) FROM PUBLIC,app_user;

-- The public member publication executes in the original app-role writer.
-- Its identity and exact recent lease are owned by the same transaction.
CREATE FUNCTION public.pin_public_member_conversation_publication(
 target_assistant uuid, credential jsonb, actor uuid, visitor text, channel text, expected_session uuid,
 expected_version bigint, lease uuid
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $publication$
DECLARE e public.conversation_envelopes;
BEGIN
 IF credential->>'kind' IS DISTINCT FROM 'api_key' OR actor IS NULL
  OR actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
  OR target_assistant IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')::uuid
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 e:=public.public_conversation_session_current(target_assistant,credential,actor,visitor,channel,
  expected_session,actor,NULL,expected_version,true,lease);
 RETURN jsonb_build_object('sessionId',e.session_id,'workspaceId',e.workspace_id,'starterUserId',e.starter_user_id,
  'version',e.version::text,'visibility',e.visibility,'cap',e.cap,'compartments',e.compartments,'projectIds',e.project_ids);
END $publication$;
REVOKE ALL ON FUNCTION public.pin_public_member_conversation_publication(uuid,jsonb,uuid,text,text,uuid,bigint,uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.pin_public_member_conversation_publication(uuid,jsonb,uuid,text,text,uuid,bigint,uuid) TO app_user;

-- The visitor read projection carries no raw tool, attachment or metadata
-- bytes. The app role cannot call this port with a guessed proof.
CREATE FUNCTION public.read_public_conversation_history(
 target_assistant uuid, credential jsonb, attributed_actor uuid,
 visitor text, channel text, row_limit integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $public_history$
DECLARE e public.conversation_envelopes;output jsonb;
BEGIN
 IF row_limit IS NULL OR row_limit NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 e:=public.public_conversation_session_current(target_assistant,credential,attributed_actor,visitor,channel);
 IF e.session_id IS NULL THEN RETURN '[]'::jsonb; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',selected.id,'role',selected.role,
  'content',projection.content,'sequenceNum',selected.sequence_num,'createdAt',selected.created_at)
  ORDER BY selected.sequence_num),'[]') INTO output
 FROM (SELECT * FROM public.conversation_record_rows(e,0,NULL,false,e.starter_user_id,true)
       ORDER BY sequence_num LIMIT row_limit) selected
 CROSS JOIN LATERAL (
  SELECT btrim(regexp_replace(CASE jsonb_typeof(selected.content)
   WHEN 'string' THEN selected.content#>>'{}'
   WHEN 'array' THEN (SELECT string_agg(block->>'text',E'\n\n' ORDER BY ord)
    FROM jsonb_array_elements(selected.content) WITH ORDINALITY items(block,ord)
    WHERE block->>'type'='text' AND jsonb_typeof(block->'text')='string' AND block->>'text'<>'') END,
   '<attached_file([[:space:]][^>]*|)>.*?(</attached_file>|$)','', 'gi')) AS content
 ) projection
 WHERE projection.content<>'' AND NOT jsonb_path_exists(selected.content,
  '$[*] ? (@.type == "tool_use" || @.type == "tool_result" || @.type == "host_observation")');
 RETURN output;
END $public_history$;
REVOKE ALL ON FUNCTION public.read_public_conversation_history(uuid,jsonb,uuid,text,text,integer) FROM PUBLIC,app_user;
