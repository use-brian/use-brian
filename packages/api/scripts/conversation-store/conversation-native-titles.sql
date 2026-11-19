-- [COMP:api/conversation-visibility] Independent native title authority.
CREATE FUNCTION public.conversation_title_record_current(e public.conversation_envelopes,title_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $current$
DECLARE capture public.private_transcript_observations;actor uuid;generation bigint;projection jsonb;s public.sessions;legacy_allowed boolean:=false;
BEGIN
 FOR capture IN SELECT o.* FROM public.scope_derivations title
  JOIN public.scope_derivation_sources parent ON parent.workspace_id=title.workspace_id AND parent.derivation_id=title.id
   AND parent.source_kind='session_context_revision'
  JOIN public.scope_derivations frame ON frame.workspace_id=parent.workspace_id AND frame.resource_kind=parent.source_kind
   AND frame.resource_id=parent.source_id AND frame.resource_version=parent.source_version
  JOIN public.scope_derivation_sources record ON record.workspace_id=frame.workspace_id AND record.derivation_id=frame.id
   AND record.source_kind='conversation_record' AND record.source_version='1'
  LEFT JOIN public.private_transcript_observations o ON o.workspace_id=record.workspace_id AND o.id=record.source_id
  WHERE title.workspace_id=e.workspace_id AND title.resource_kind='session_context_revision' AND title.resource_id=title_id
 LOOP
  IF capture.id IS NULL OR capture.session_id IS DISTINCT FROM e.session_id
   OR capture.binding->>'purpose' IS DISTINCT FROM 'native_session_title' THEN RETURN false;END IF;
  generation:=(capture.binding->>'generation')::bigint;
  IF generation IS NULL OR generation>e.version THEN RETURN false;END IF;
  IF capture.binding->'legacyRowsSelected'='true'::jsonb THEN
   SELECT * INTO s FROM public.sessions WHERE id=e.session_id;
   legacy_allowed:=public.conversation_legacy_enrolled(e.session_id,e.workspace_id,s.user_id,s.assistant_id);
   IF NOT legacy_allowed THEN RETURN false;END IF;
  END IF;
  -- An audit accounts for a settings-only generation. Only a withdrawal
  -- requires comparing this title's bounded, originally selected dialogue.
  IF generation<e.version AND e.version-generation>(SELECT count(*) FROM public.conversation_visibility_audit a
   WHERE a.session_id=e.session_id AND a.next_version>generation AND a.next_version<=e.version) THEN
   actor:=(capture.binding->>'readerUserId')::uuid;
   projection:=public.project_conversation_record(e,(capture.manifest->>'afterSequence')::integer,
    (capture.manifest->>'throughSequence')::integer,(capture.manifest->>'topicThroughSequence')::integer,legacy_allowed,actor);
   IF (projection->'manifest'->'payloadDigest') IS DISTINCT FROM capture.manifest->'payloadDigest' THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
END $current$;
REVOKE ALL ON FUNCTION public.conversation_title_record_current(public.conversation_envelopes,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.native_conversation_title_context(sid uuid,device uuid,native_version integer,answering uuid,mutation boolean)
RETURNS public.conversation_envelopes
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $context$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;w uuid;
 s public.sessions;e public.conversation_envelopes;assistant_clearance text;
BEGIN
 IF actor IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 SELECT workspace_id INTO w FROM public.conversation_envelopes WHERE session_id=sid;
 IF w IS NULL THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
 PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 PERFORM public.native_conversation_read_credential(device,native_version,true);
 SELECT clearance INTO assistant_clearance FROM public.assistants WHERE id=answering AND workspace_id=w FOR SHARE;
 IF NOT FOUND OR public.assistant_placement_visible(actor,answering) IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 IF mutation THEN SELECT * INTO s FROM public.sessions WHERE id=sid AND workspace_id=w FOR UPDATE;
 ELSE SELECT * INTO s FROM public.sessions WHERE id=sid AND workspace_id=w FOR SHARE;END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id=w;
 IF NOT FOUND OR s.id IS NULL OR public.conversation_member_read_current(w,sid,actor) IS NOT TRUE
  OR public.sensitivity_rank(assistant_clearance)<public.sensitivity_rank(e.cap)
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 RETURN e;
END $context$;
REVOKE ALL ON FUNCTION public.native_conversation_title_context(uuid,uuid,integer,uuid,boolean) FROM PUBLIC,app_user;

CREATE FUNCTION public.prepare_native_conversation_title(sid uuid,device uuid,native_version integer,answering uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $prepare$
DECLARE e public.conversation_envelopes;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 head_id uuid;previous jsonb;turn_count integer:=0;through_sequence integer;capture jsonb;legacy_allowed boolean:=false;
 s public.sessions;
BEGIN
 e:=public.native_conversation_title_context(sid,device,native_version,answering,false);
 SELECT h.scope_revision_id INTO head_id FROM public.session_title_heads h WHERE h.session_id=sid AND h.workspace_id=e.workspace_id;
 IF head_id IS NOT NULL THEN
  SELECT c.content INTO previous FROM public.session_context_scope_revisions r
   JOIN public.session_context_revision_contents c ON c.workspace_id=r.workspace_id AND c.revision_id=r.id
   WHERE r.id=head_id AND r.workspace_id=e.workspace_id AND r.session_id=sid AND r.parent_kind='session_title' AND NOT r.scope_held
    AND NOT public.scope_review_state_held('session_context_revision',r.id)
    AND public.session_context_payload_shape('session_title',c.content);
 END IF;
 IF previous->'manual' IS DISTINCT FROM 'true'::jsonb THEN
  IF previous IS NOT NULL THEN
   SELECT * INTO s FROM public.sessions WHERE id=sid;
   IF e.visibility='private_by_kind' THEN
    legacy_allowed:=public.enroll_conversation_legacy_history(sid)
     AND public.conversation_legacy_enrolled(sid,e.workspace_id,s.user_id,s.assistant_id);
   END IF;
   SELECT count(*)::int INTO turn_count FROM public.conversation_record_rows(e,0,NULL,legacy_allowed,actor,false) m
    WHERE m.role='user' AND public.conversation_searchable_text(m.content) IS NOT NULL;
  END IF;
  SELECT coalesce(max(selected.sequence_num),0) INTO through_sequence FROM (
   SELECT m.sequence_num FROM public.session_messages m WHERE m.session_id=sid ORDER BY m.sequence_num LIMIT 10
  ) selected;
  capture:=public.capture_conversation_record_current(e.workspace_id,sid,0,through_sequence,0,
   jsonb_build_object('deviceId',device,'authVersion',native_version,'assistantId',answering,'headId',head_id));
 END IF;
 RETURN jsonb_build_object('sessionId',sid,'workspaceId',e.workspace_id,'headId',head_id,'previous',previous,
  'turnCount',turn_count,'throughSequence',through_sequence,'record',capture);
END $prepare$;

CREATE FUNCTION public.require_native_conversation_title_capture(w uuid,sid uuid,device uuid,native_version integer,
 answering uuid,capture_id uuid,expected_head uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $capture$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;source jsonb;current_head uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.private_transcript_observations o WHERE o.workspace_id=w AND o.id=capture_id AND o.session_id=sid
  AND o.binding->>'purpose'='native_session_title' AND o.binding->>'readerUserId'=actor::text
  AND o.binding->'titleBinding'=jsonb_build_object('deviceId',device,'authVersion',native_version,'assistantId',answering,'headId',expected_head))
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 source:=public.conversation_record_publication_source(w,capture_id,sid,actor,true);
 IF source->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 SELECT h.scope_revision_id INTO current_head FROM public.session_title_heads h WHERE h.session_id=sid AND h.workspace_id=w;
 IF current_head IS DISTINCT FROM expected_head THEN RETURN NULL;END IF;
 RETURN source-ARRAY['held','validTo','retractedAt'];
END $capture$;
REVOKE ALL ON FUNCTION public.require_native_conversation_title_capture(uuid,uuid,uuid,integer,uuid,uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.check_native_conversation_title(sid uuid,device uuid,native_version integer,answering uuid,capture_id uuid,
 expected_head uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $check$
DECLARE e public.conversation_envelopes;
BEGIN
 e:=public.native_conversation_title_context(sid,device,native_version,answering,false);
 RETURN public.require_native_conversation_title_capture(e.workspace_id,sid,device,native_version,answering,capture_id,expected_head) IS NOT NULL;
END $check$;

CREATE FUNCTION public.publish_native_conversation_title(sid uuid,device uuid,native_version integer,answering uuid,capture_id uuid,
 expected_head uuid,label text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $publish$
DECLARE e public.conversation_envelopes;source jsonb;payload jsonb;revision uuid:=gen_random_uuid();written jsonb;
BEGIN
 e:=public.native_conversation_title_context(sid,device,native_version,answering,true);
 source:=public.require_native_conversation_title_capture(e.workspace_id,sid,device,native_version,answering,capture_id,expected_head);
 IF source IS NULL THEN RETURN NULL;END IF;
 payload:=jsonb_build_object('title',label,'manual',false);
 IF public.session_context_payload_shape('session_title',payload) IS NOT TRUE THEN RAISE EXCEPTION 'conversation_title_invalid' USING ERRCODE='22023';END IF;
 written:=public.publish_native_session_context_revision(e.workspace_id,sid,'session_title',sid,revision,payload,
  'turn:session-title',jsonb_build_array(source),expected_head,NULL,NULL);
 RETURN CASE WHEN written IS NULL THEN NULL ELSE jsonb_build_object('title',label,'titleRevisionId',revision) END;
END $publish$;

CREATE FUNCTION public.read_native_conversation_title_result(sid uuid,device uuid,native_version integer,answering uuid,
 expected_head uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $egress$
DECLARE title jsonb;
BEGIN
 PERFORM public.native_conversation_title_context(sid,device,native_version,answering,false);
 title:=public.read_conversation_title_current(sid);
 RETURN CASE WHEN title->>'titleRevisionId'=expected_head::text THEN title ELSE NULL END;
END $egress$;

REVOKE ALL ON FUNCTION public.prepare_native_conversation_title(uuid,uuid,integer,uuid),
 public.check_native_conversation_title(uuid,uuid,integer,uuid,uuid,uuid),
 public.publish_native_conversation_title(uuid,uuid,integer,uuid,uuid,uuid,text),
 public.read_native_conversation_title_result(uuid,uuid,integer,uuid,uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.prepare_native_conversation_title(uuid,uuid,integer,uuid),
 public.check_native_conversation_title(uuid,uuid,integer,uuid,uuid,uuid),
 public.publish_native_conversation_title(uuid,uuid,integer,uuid,uuid,uuid,text),
 public.read_native_conversation_title_result(uuid,uuid,integer,uuid,uuid) TO app_user;
