-- [COMP:api/telegram-conversation-context] Exact normal provider-room evidence.
CREATE FUNCTION public.capture_verified_telegram_conversation_evidence(
  w uuid, sid uuid, actor uuid, responder uuid, address text, integration uuid,
  bot text, epoch bigint, envelope_version bigint, lease uuid, speaker text,
  incoming_id text, roots jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $telegram_evidence$
DECLARE
  s public.sessions;
  e public.conversation_envelopes;
  channel uuid;
  parent_address text;
  n record;
  memo jsonb;
  current_source jsonb;
  current_labels jsonb := '[]';
  immutable jsonb := '[]';
  original_context jsonb;
  node_count integer := 0;
BEGIN
  IF num_nulls(w,sid,actor,responder,address,integration,bot,epoch,envelope_version,lease,speaker,incoming_id)<>0
    OR actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
    OR responder IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')::uuid
    OR current_setting('app.agent_shared_audience',true) IS DISTINCT FROM 'true'
    OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
    OR address !~ '^-[0-9]+(:(topic|discussion):[0-9]+)?$'
    OR speaker !~ '^[0-9]+$' OR incoming_id !~ '^[0-9]+$'
    OR jsonb_typeof(roots) IS DISTINCT FROM 'array'
    OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096
    OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
      WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501'; END IF;

  IF EXISTS(SELECT 1 FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
    WHERE r.kind NOT IN ('application_field','session_message','session_context_revision')
      OR r.id IS NULL OR r.version IS NULL)
  THEN RETURN NULL; END IF;

  PERFORM id FROM public.workspaces WHERE id=w FOR SHARE NOWAIT;
  PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501'; END IF;
  PERFORM id FROM public.linked_identities WHERE provider='telegram' AND provider_id=speaker AND user_id=actor FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501'; END IF;

  SELECT c.id INTO channel FROM public.channel_integrations ci JOIN public.channels c ON c.id=ci.channel_id
    WHERE ci.id=integration AND ci.channel_type='telegram' AND c.channel_type='telegram'
      AND ci.status='active' AND c.status='active' AND c.workspace_id=w
      AND ci.bot_user_id=bot AND ci.identity_generation=epoch
    FOR SHARE OF c,ci NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501'; END IF;
  parent_address:=split_part(address,':',1);
  IF (SELECT ca.assistant_id FROM public.channel_assistants ca WHERE ca.channel_id=channel
    AND (ca.external_surface_id IS NULL OR ca.external_surface_id IN(address,parent_address))
    ORDER BY CASE WHEN ca.external_surface_id=address THEN 0 WHEN ca.external_surface_id=parent_address THEN 1 ELSE 2 END
    LIMIT 1 FOR SHARE NOWAIT) IS DISTINCT FROM responder
  THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501'; END IF;

  SELECT * INTO s FROM public.sessions WHERE workspace_id=w AND id=sid FOR SHARE NOWAIT;
  IF NOT FOUND OR s.channel_type<>'telegram' OR s.channel_id<>address OR s.archived_at IS NOT NULL
    OR s.anchor_kind<>'channel' OR s.anchor_ref<>address OR s.assistant_id<>responder
    OR s.provider_conversation_context IS NOT TRUE
    OR s.provider_context_generation IS DISTINCT FROM epoch
    OR s.provider_context_identity->>'integrationId' IS DISTINCT FROM integration::text
    OR s.provider_context_identity->>'botId' IS DISTINCT FROM bot
    OR (s.provider_context_identity->>'generation')::bigint>epoch
    OR s.turn_lease_token IS DISTINCT FROM lease OR s.last_turn_lease_token IS DISTINCT FROM lease OR s.status<>'running'
    OR s.cancel_requested_at IS NOT NULL OR s.turn_heartbeat_at IS NULL
    OR s.turn_heartbeat_at<=clock_timestamp()-interval '90 seconds'
    OR coalesce(s.turn_assistant_id,s.assistant_id)<>responder
    OR s.recording_revision IS NOT NULL OR s.recording_privacy_held IS TRUE
    OR public.scope_review_state_held('session',sid)
    OR EXISTS(SELECT 1 FROM public.channel_recording_policies p WHERE p.workspace_id=w
      AND p.bot_id=bot AND p.conversation_id=address AND NOT p.enabled)
    OR NOT EXISTS(SELECT 1 FROM public.session_messages m WHERE m.workspace_id=w AND m.session_id=sid
      AND m.role='user' AND m.sender_user_id=actor AND m.channel_message_id=incoming_id)
  THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501'; END IF;

  SELECT * INTO e FROM public.conversation_envelopes WHERE workspace_id=w AND session_id=sid FOR SHARE NOWAIT;
  IF NOT FOUND OR e.visibility<>'workspace' OR e.version<>envelope_version OR e.starter_user_id<>s.user_id
    OR public.conversation_member_read_current(w,sid,actor) IS NOT TRUE
    OR public.native_turn_helpers_current() IS NOT TRUE
  THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501'; END IF;

  original_context:=public.native_turn_context();
  memo:=public.conversation_dag(w,roots,'[]');
  FOR n IN
    WITH RECURSIVE closure(kind,id,version) AS (
      SELECT r.kind,r.id,r.version FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
      UNION SELECT next.kind,next.id,next.version FROM closure c
        CROSS JOIN LATERAL public.conversation_source_edges(w,c.kind,c.id,c.version) next
    )
    SELECT * FROM closure LIMIT 4097
  LOOP
    node_count:=node_count+1;
    IF node_count>4096 THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501'; END IF;
    CASE n.kind
      WHEN 'application_query_domain' THEN
        IF NOT EXISTS(SELECT 1 FROM public.application_query_domains d WHERE d.workspace_id=w AND d.id=n.id
          AND d.origin='{"kind":"native","moduleKey":"native"}'::jsonb
          AND d.type_key IN ('session_message','session_message_annotation') AND d.identity=n.version
          AND d.domain->>'sessionId'=sid::text) THEN RETURN NULL; END IF;
        CONTINUE;
      WHEN 'application_field' THEN
        IF NOT EXISTS(SELECT 1 FROM public.application_field_resources f WHERE f.workspace_id=w AND f.id=n.id
          AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
          AND f.type_key IN ('session_message','session_message_annotation')
          AND (f.selection='query_domain' AND EXISTS(SELECT 1 FROM public.application_query_domains d
              WHERE d.workspace_id=w AND d.id=f.resource_id AND d.domain->>'sessionId'=sid::text)
            OR f.selection='query' AND EXISTS(SELECT 1 FROM public.session_messages m
              WHERE m.workspace_id=w AND m.id=f.resource_id AND m.session_id=sid))) THEN RETURN NULL; END IF;
        current_source:=memo#>ARRAY['field:'||n.id||':'||n.version,'value'];
      WHEN 'session_message' THEN
        IF NOT EXISTS(SELECT 1 FROM public.session_messages m WHERE m.workspace_id=w AND m.id=n.id AND m.session_id=sid)
        THEN RETURN NULL; END IF;
        IF memo#>>ARRAY['native:session_message:'||n.id||':'||n.version,'value'] IS DISTINCT FROM 'true'
        THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
        current_source:=memo#>ARRAY['current','session_message:'||n.id||':'||n.version];
      WHEN 'session_context_revision' THEN
        IF NOT EXISTS(SELECT 1 FROM public.session_context_scope_revisions r
          WHERE r.workspace_id=w AND r.id=n.id AND r.session_id=sid)
        THEN RETURN NULL; END IF;
        IF memo#>>ARRAY['native:session_context_revision:'||n.id||':'||n.version,'value'] IS DISTINCT FROM 'true'
        THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
        current_source:=memo#>ARRAY['current','session_context_revision:'||n.id||':'||n.version];
      ELSE RETURN NULL;
    END CASE;
    IF current_source->>'held' IS DISTINCT FROM 'false'
      OR current_source->>'version' IS DISTINCT FROM n.version
      OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
    THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
    current_source:=jsonb_build_object(
      'workspaceId',w,'resourceKind',n.kind,'resourceId',n.id,'version',n.version,
      'userId',current_source->'userId','assistantId',current_source->'assistantId',
      'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds');
    IF n.kind IN ('application_field','session_context_revision') THEN
      immutable:=immutable||jsonb_build_array(current_source);
    END IF;
    current_labels:=current_labels||jsonb_build_array(current_source);
  END LOOP;
  IF public.native_turn_helpers_current() IS NOT TRUE OR public.native_turn_context() IS DISTINCT FROM original_context
    OR clock_timestamp()>=(memo->>'validUntil')::timestamptz
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('current',current_labels,'immutable',immutable);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501';
END $telegram_evidence$;
REVOKE ALL ON FUNCTION public.capture_verified_telegram_conversation_evidence(uuid,uuid,uuid,uuid,text,uuid,text,bigint,bigint,uuid,text,text,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_verified_telegram_conversation_evidence(uuid,uuid,uuid,uuid,text,uuid,text,bigint,bigint,uuid,text,text,jsonb) TO app_user;
