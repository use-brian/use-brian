-- [COMP:api/conversation-visibility] Direct app-role SELECTs use the native
-- conversation authority. Existing INSERT/UPDATE/DELETE checks keep ownership.
CREATE FUNCTION public.conversation_rls_session_current(sid uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $session$
 SELECT nullif(current_setting('app.application_id',true),'') IS NULL
  AND EXISTS(SELECT 1 FROM public.conversation_envelopes e WHERE e.session_id=sid
   AND public.conversation_member_read_current(e.workspace_id,sid,nullif(current_setting('app.current_user_id',true),'')::uuid))
$session$;

CREATE FUNCTION public.conversation_rls_message_current(sid uuid,mid uuid,sequence integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $message$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 e public.conversation_envelopes;s public.sessions;legacy_allowed boolean:=false;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL OR sequence<1 THEN RETURN false;END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid;
 IF NOT FOUND OR public.conversation_member_read_current(e.workspace_id,sid,actor) IS NOT TRUE THEN RETURN false;END IF;
 IF e.workspace_id IS NOT NULL AND e.visibility='private_by_kind' THEN
  SELECT * INTO s FROM public.sessions WHERE id=sid;
  legacy_allowed:=public.conversation_legacy_enrolled(sid,e.workspace_id,s.user_id,s.assistant_id);
 END IF;
 RETURN EXISTS(SELECT 1 FROM public.conversation_record_rows(e,sequence-1,sequence,legacy_allowed,actor,true) m
  WHERE m.id=mid AND lower(m.content::text) NOT LIKE '%<attached_file%'
   AND CASE jsonb_typeof(m.content) WHEN 'string' THEN true WHEN 'array' THEN NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(m.content) block WHERE CASE jsonb_typeof(block) WHEN 'object' THEN
     block->>'type' IS DISTINCT FROM 'text' OR jsonb_typeof(block->'text') IS DISTINCT FROM 'string'
     OR block-ARRAY['type','text']<>'{}'::jsonb ELSE true END) ELSE false END);
END $message$;

REVOKE ALL ON FUNCTION public.conversation_rls_session_current(uuid),public.conversation_rls_message_current(uuid,uuid,integer) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.conversation_rls_session_current(uuid),public.conversation_rls_message_current(uuid,uuid,integer) TO app_user;

-- The restrictive policies make the decision for every SELECT route. An
-- authenticated actor may reach that check even when the legacy owner policy
-- would otherwise exclude an audited participant.
CREATE POLICY sessions_conversation_envelope_select ON public.sessions FOR SELECT TO app_user
 USING (nullif(current_setting('app.current_user_id',true),'') IS NOT NULL);
CREATE POLICY sessions_conversation_envelope_floor ON public.sessions AS RESTRICTIVE FOR SELECT TO app_user
 USING (public.conversation_rls_session_current(id));
CREATE POLICY session_messages_conversation_record_select ON public.session_messages FOR SELECT TO app_user
 USING (nullif(current_setting('app.current_user_id',true),'') IS NOT NULL);
CREATE POLICY session_messages_conversation_record_floor ON public.session_messages AS RESTRICTIVE FOR SELECT TO app_user
 USING (public.conversation_rls_message_current(session_id,id,sequence_num));

CREATE FUNCTION public.conversation_searchable_text(content jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $text$
 SELECT CASE WHEN jsonb_path_exists(content,'$[*] ? (@.type == "tool_use" || @.type == "tool_result" || @.type == "host_observation")') THEN NULL
  ELSE btrim(regexp_replace(CASE jsonb_typeof(content) WHEN 'string' THEN content#>>'{}'
   WHEN 'array' THEN (SELECT string_agg(block->>'text',' ' ORDER BY ordinality)
    FROM jsonb_array_elements(content) WITH ORDINALITY blocks(block,ordinality) WHERE block->>'type'='text') END,
   '<attached_file([[:space:]][^>]*|)>.*?(</attached_file>|$)','', 'gi')) END
$text$;
REVOKE ALL ON FUNCTION public.conversation_searchable_text(jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.conversation_searchable_text(jsonb) TO app_user;

CREATE FUNCTION public.read_conversation_search_text_current(sid uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $search$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 e public.conversation_envelopes;s public.sessions;legacy_allowed boolean:=false;
BEGIN
 IF public.conversation_rls_session_current(sid) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid;
 IF e.workspace_id IS NOT NULL AND e.visibility='private_by_kind' THEN
  SELECT * INTO s FROM public.sessions WHERE id=sid;
  legacy_allowed:=public.conversation_legacy_enrolled(sid,e.workspace_id,s.user_id,s.assistant_id);
 END IF;
 RETURN (SELECT string_agg(public.conversation_searchable_text(m.content),' ' ORDER BY m.sequence_num)
  FROM public.conversation_record_rows(e,0,NULL,legacy_allowed,actor,true) m);
END $search$;
REVOKE ALL ON FUNCTION public.read_conversation_search_text_current(uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.read_conversation_search_text_current(uuid) TO app_user;

CREATE FUNCTION public.read_conversation_title_current(sid uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $title$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 e public.conversation_envelopes;s public.sessions;head_id uuid;label text;legacy_allowed boolean:=false;
BEGIN
 IF public.conversation_rls_session_current(sid) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid;
 SELECT h.scope_revision_id INTO head_id FROM public.session_title_heads h WHERE h.session_id=sid AND h.workspace_id=e.workspace_id;
 IF head_id IS NOT NULL THEN
  SELECT c.content->>'title' INTO label FROM public.session_context_scope_revisions r
   JOIN public.session_context_revision_contents c ON c.workspace_id=r.workspace_id AND c.revision_id=r.id
   WHERE r.id=head_id AND r.workspace_id=e.workspace_id AND r.session_id=sid AND r.parent_kind='session_title'
    AND NOT r.scope_held AND NOT public.scope_review_state_held('session_context_revision',r.id)
    AND public.conversation_title_record_current(e,r.id);
  RETURN CASE WHEN label IS NULL THEN NULL ELSE jsonb_build_object('title',label,'titleRevisionId',head_id) END;
 END IF;
 IF e.workspace_id IS NOT NULL AND e.visibility='private_by_kind' THEN
  SELECT * INTO s FROM public.sessions WHERE id=sid;
  legacy_allowed:=public.conversation_legacy_enrolled(sid,e.workspace_id,s.user_id,s.assistant_id);
 END IF;
 SELECT left(nullif(public.conversation_searchable_text(m.content),''),200) INTO label
  FROM public.conversation_record_rows(e,0,NULL,legacy_allowed,actor,true) m
  WHERE m.role='user' AND nullif(public.conversation_searchable_text(m.content),'') IS NOT NULL
  ORDER BY m.sequence_num LIMIT 1;
 RETURN CASE WHEN label IS NULL THEN NULL ELSE jsonb_build_object('title',label,'titleRevisionId',NULL) END;
END $title$;
REVOKE ALL ON FUNCTION public.read_conversation_title_current(uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.read_conversation_title_current(uuid) TO app_user;
