BEGIN;
-- [COMP:api/session-display-history] Ordinary owner history is presentation,
-- not a new source query. Only the server presentation adapter consumes this
-- protected row projection; it never becomes model evidence.
CREATE FUNCTION read_private_chat_messages(w uuid,i uuid,device uuid,version integer,after_sequence integer,page_size integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 parent jsonb;s sessions;receipt session_legacy_history;item record;envelope jsonb;readable boolean;
 result jsonb:='[]';next_sequence integer;seen integer:=0;more boolean:=false;
BEGIN
 IF after_sequence IS NULL OR after_sequence<0 OR page_size IS NULL OR page_size<1 OR page_size>100 THEN
  RAISE EXCEPTION 'invalid_chat_presentation' USING ERRCODE='22023';END IF;
 parent:=private_session_display_parent(w,i,device,version);
 SELECT * INTO STRICT s FROM sessions WHERE id=i;
 IF s.channel_type<>'web' OR coalesce(s.app_origin,'chat')<>'chat' OR s.visibility<>'personal'
  OR s.user_id IS DISTINCT FROM actor OR s.anchor_kind<>'none' OR s.mode IS NOT NULL
  OR s.workspace_id IS NOT NULL AND s.workspace_id<>w
  OR scope_review_state_held('session',i) IS TRUE
 THEN RAISE EXCEPTION 'chat_presentation_unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO receipt FROM session_legacy_history WHERE session_id=i AND workspace_id=w AND user_id=actor;
 IF s.workspace_id IS NULL AND receipt.session_id IS NULL
  OR receipt.session_id IS NOT NULL AND receipt.binding IS DISTINCT FROM private_legacy_history_binding(s)
 THEN RAISE EXCEPTION 'chat_presentation_unavailable' USING ERRCODE='42501';END IF;
 -- Retain the same direct policy locks as the text-only display port.
 PERFORM singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'chat_presentation_unavailable' USING ERRCODE='42501';END IF;
 PERFORM workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'chat_presentation_unavailable' USING ERRCODE='42501';END IF;
 PERFORM workspace_id FROM workspace_access_policies WHERE workspace_id=w FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'chat_presentation_unavailable' USING ERRCODE='42501';END IF;
 FOR item IN
  SELECT m AS message,h.fingerprint,coalesce(h.sequence_num,m.sequence_num) AS sequence
  FROM session_messages m LEFT JOIN session_legacy_history_messages h ON h.session_id=m.session_id AND h.message_id=m.id
  WHERE m.session_id=i AND coalesce(h.sequence_num,m.sequence_num)>after_sequence
   AND m.role IN('user','assistant')
  ORDER BY coalesce(h.sequence_num,m.sequence_num),m.id LIMIT page_size+1 FOR SHARE OF m
 LOOP
  seen:=seen+1;IF seen>page_size THEN more:=true;EXIT;END IF;next_sequence:=item.sequence;
  readable:=false;
  envelope:=jsonb_build_object('workspaceId',(item.message).workspace_id,'userId',(item.message).user_id,
   'assistantId',(item.message).assistant_id,'sensitivity',(item.message).sensitivity,
   'compartments',(item.message).compartments,'projectIds',(item.message).project_ids);
  IF item.fingerprint IS NOT NULL THEN
   readable:=receipt.session_id IS NOT NULL AND octet_length((item.message).content::text)<=131072
    AND encode(sha256(convert_to(to_jsonb(item.message)::text,'UTF8')),'hex')=item.fingerprint
    AND ((item.message).workspace_id IS NULL OR (item.message).workspace_id=w)
    AND ((item.message).user_id IS NULL OR (item.message).user_id=actor)
    AND ((item.message).sender_user_id IS NULL OR (item.message).sender_user_id=actor);
   IF readable AND ((item.message).workspace_id IS NOT NULL OR (item.message).user_id IS NOT NULL
    OR (item.message).assistant_id IS NOT NULL OR (item.message).sensitivity IS NOT NULL
    OR (item.message).compartments IS NOT NULL OR (item.message).project_ids IS NOT NULL OR (item.message).scope_version IS NOT NULL)
   THEN readable:=workflow_evidence_envelope_visible(w,envelope) IS TRUE;END IF;
  ELSE
   readable:=(item.message).workspace_id=w AND (item.message).user_id=actor
    AND (item.message).scope_version IS NOT NULL AND (item.message).scope_held IS FALSE
    AND (item.message).sensitivity IN('public','internal','confidential')
    AND (item.message).compartments IS NOT NULL AND (item.message).project_ids IS NOT NULL
    AND agent_visibility_allows(w,(item.message).user_id,(item.message).assistant_id) IS TRUE
    AND workflow_evidence_envelope_visible(w,envelope) IS TRUE;
  END IF;
  readable:=readable AND (item.message).scope_held IS NOT TRUE
   AND scope_review_state_held('session_message',(item.message).id) IS NOT TRUE;
  IF readable OR jsonb_typeof((item.message).content)='string' OR (
   jsonb_typeof((item.message).content)='array'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements((item.message).content) b WHERE b->>'type' IN('text','image'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((item.message).content) b
    WHERE b->>'type' IN('tool_use','tool_result','host_observation')))
  THEN
   result:=result||jsonb_build_array(jsonb_build_object('id',(item.message).id,'sequence',item.sequence,
    'role',(item.message).role,'timestamp',(item.message).created_at,'available',coalesce(readable,false),
    'content',CASE WHEN readable THEN (item.message).content ELSE NULL END,
    'senderUserId',CASE WHEN readable THEN (item.message).sender_user_id ELSE NULL END,
    'senderAssistantId',CASE WHEN readable THEN (item.message).sender_assistant_id ELSE NULL END,
    'publishedSenderName',CASE WHEN readable THEN (item.message).published_sender_name ELSE NULL END,
    'replyToText',CASE WHEN readable THEN (item.message).reply_to_text ELSE NULL END,
    'attachments',CASE WHEN readable THEN (item.message).attachments ELSE '[]'::jsonb END));
  END IF;
 END LOOP;
 IF private_session_display_parent(w,i,device,version) IS DISTINCT FROM parent THEN
  RAISE EXCEPTION 'chat_presentation_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('sessionId',i,'workspaceId',w,'rows',result,'nextSequence',CASE WHEN more THEN next_sequence ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION read_private_chat_messages(uuid,uuid,uuid,integer,integer,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_private_chat_messages(uuid,uuid,uuid,integer,integer,integer) TO app_user;
END IF;END $$;
COMMIT;
