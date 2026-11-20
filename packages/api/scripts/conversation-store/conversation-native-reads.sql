-- [COMP:api/conversation-visibility] Native display uses the same envelope and
-- immutable row selection as the dialogue owner, without acquiring a capture.
CREATE FUNCTION public.native_conversation_read_credential(device uuid,native_version integer,lock_credential boolean)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $credential$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 IF lock_credential THEN
  PERFORM a.id FROM public.auth_sessions a JOIN public.users u ON u.id=a.user_id
   WHERE a.id=device AND a.user_id=actor AND a.auth_version=native_version AND u.auth_version=native_version
    AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() FOR SHARE OF a,u;
 ELSE
  PERFORM a.id FROM public.auth_sessions a JOIN public.users u ON u.id=a.user_id
   WHERE a.id=device AND a.user_id=actor AND a.auth_version=native_version AND u.auth_version=native_version
    AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp();
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 RETURN actor;
END $credential$;
REVOKE ALL ON FUNCTION public.native_conversation_read_credential(uuid,integer,boolean) FROM PUBLIC,app_user;

CREATE FUNCTION public.read_native_conversation_history(sid uuid,device uuid,native_version integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $history$
DECLARE actor uuid:=public.native_conversation_read_credential(device,native_version,false);
 e public.conversation_envelopes;s public.sessions;w uuid;legacy_allowed boolean:=false;
 rows jsonb;compiled_rows jsonb;guest_name text;
BEGIN
 e:=public.conversation_envelope_for_reader(sid,actor);
 IF e.session_id IS NULL THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 w:=e.workspace_id;
 IF w IS NOT NULL THEN
  PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
  PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 END IF;
 PERFORM public.native_conversation_read_credential(device,native_version,true);
 SELECT * INTO s FROM public.sessions WHERE id=sid FOR SHARE;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id IS NOT DISTINCT FROM w FOR SHARE;
 IF NOT FOUND OR public.conversation_member_read_current(w,sid,actor) IS NOT TRUE THEN
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 IF w IS NOT NULL AND e.visibility='private_by_kind' THEN
  legacy_allowed:=public.enroll_conversation_legacy_history(sid) AND public.conversation_legacy_enrolled(sid,w,s.user_id,s.assistant_id);
 END IF;
 IF s.anchor_kind='doc_thread' THEN
  SELECT ct.external_author_name INTO guest_name FROM public.comment_threads ct WHERE ct.session_id=sid AND ct.workspace_id=w;
 END IF;
 IF to_regprocedure('public.read_compiled_conversation_payload(conversation_envelopes,integer,integer,integer,boolean,uuid,text)') IS NOT NULL THEN
  compiled_rows:=public.read_compiled_conversation_payload(e,0,NULL,NULL,legacy_allowed,actor,'visual_rows_v1')->'rows';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'sequence',m.sequence_num,'role',m.role,
  'timestamp',m.created_at,'content',m.content,'senderUserId',m.sender_user_id,'senderAssistantId',m.sender_assistant_id,
  'publishedSenderName',m.published_sender_name,'replyToText',content.content->>'replyToText','attachments',coalesce(m.attachments,'[]'),
  'senderName',coalesce(u.name,u.email),'senderAvatarUrl',u.avatar_url,
  'authoredByViewer',coalesce(m.sender_user_id=actor,m.role='user' AND e.visibility='private_by_kind' AND e.starter_user_id=actor))
  ORDER BY m.sequence_num),'[]') INTO rows
 FROM (
  SELECT source.* FROM public.conversation_record_rows(e,0,NULL,legacy_allowed,actor,true) source WHERE compiled_rows IS NULL
  UNION ALL
  SELECT source.* FROM jsonb_populate_recordset(NULL::public.session_messages,coalesce(compiled_rows,'[]'::jsonb)) source
 ) m
 LEFT JOIN public.users u ON u.id=m.sender_user_id
 LEFT JOIN public.session_message_annotation_heads head ON head.message_id=m.id AND head.session_id=sid AND head.workspace_id=w
 LEFT JOIN public.session_context_scope_revisions r ON r.id=head.scope_revision_id AND r.workspace_id=head.workspace_id
  AND r.scope_held IS FALSE AND NOT public.scope_review_state_held('session_context_revision',r.id)
 LEFT JOIN public.session_context_revision_contents content ON content.revision_id=r.id AND content.workspace_id=r.workspace_id;
 RETURN jsonb_build_object('sessionId',sid,'version',e.version,'guestName',guest_name,'rows',rows);
END $history$;
-- The trusted native host must run the existing presentation projector before
-- sending these rows. The application role cannot invoke the raw payload port.
REVOKE ALL ON FUNCTION public.read_native_conversation_history(uuid,uuid,integer) FROM PUBLIC,app_user;
