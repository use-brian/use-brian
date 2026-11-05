BEGIN;
-- [COMP:api/session-display-history] A private transcript is a durable owner
-- record. Fresh source/model admission is deliberately a different purpose.
-- Existing messages are neither rewritten nor recertified by this migration.

CREATE OR REPLACE FUNCTION read_private_session_display(w uuid,i uuid,device uuid,version integer,after_sequence integer,page_size integer)
-- Preserve the caller's native observation settings. Session point identities
-- include timestamp JSON; changing TimeZone here would alter unchanged hashes.
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 parent jsonb;current_parent jsonb;item record;envelope jsonb;readable boolean;
 result jsonb:='[]';next_sequence integer:=NULL;more boolean:=false;seen integer:=0;
BEGIN
 IF after_sequence IS NULL OR after_sequence<0 OR page_size IS NULL OR page_size<1 OR page_size>100 THEN
  RAISE EXCEPTION 'invalid_session_display' USING ERRCODE='22023';END IF;
 parent:=private_session_display_parent(w,i,device,version);
 -- Only the transcript and its current audience authorize this read. Lock
 -- policy/review changes through commit, without traversing upstream sources.
 -- NOWAIT avoids a policy/source lock inversion with concurrent mutations.
 BEGIN
  PERFORM singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
  PERFORM workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
  PERFORM workspace_id FROM workspace_access_policies WHERE workspace_id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END;
 IF parent->>'storedWorkspaceId' IS DISTINCT FROM w::text OR parent->>'channelType' IS DISTINCT FROM 'web'
  OR coalesce(parent->>'appOrigin','chat')<>'chat'
  OR NOT EXISTS(SELECT 1 FROM sessions WHERE id=i AND workspace_id=w AND visibility='personal'
   AND user_id=actor AND anchor_kind='none' AND mode IS NULL)
  OR scope_review_state_held('session',i) IS TRUE
 THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
 -- Only final human/assistant text can enter this DTO. Shape checks select no
 -- protected text, and tool-result carriers never become phantom placeholders.
 FOR item IN SELECT m.id,m.sequence_num,m.role,m.created_at,m.scope_version,m.scope_held,
   m.user_id,m.assistant_id,m.sensitivity,m.compartments,m.project_ids
  FROM session_messages m WHERE m.workspace_id=w AND m.session_id=i AND m.sequence_num>after_sequence
   AND m.role IN('user','assistant')
   AND (jsonb_typeof(m.content)='string' OR jsonb_typeof(m.content)='array'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b
     WHERE b->>'type'='text' AND jsonb_typeof(b->'text')='string'))
   AND NOT (m.role='assistant' AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b WHERE b->>'type'='tool_use'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b WHERE b->>'type'='tool_result')
  ORDER BY m.sequence_num,m.id LIMIT page_size+1 FOR SHARE OF m
 LOOP
  seen:=seen+1;IF seen>page_size THEN more:=true;EXIT;END IF;next_sequence:=item.sequence_num;
  -- Published message scope, not the current validity of its derivation.
  -- Source mutation/deletion cannot revoke an utterance already delivered.
  envelope:=jsonb_build_object('workspaceId',w,'userId',item.user_id,
   'assistantId',item.assistant_id,'sensitivity',item.sensitivity,
   'compartments',item.compartments,'projectIds',item.project_ids);
  readable:=item.user_id=actor AND item.scope_held IS FALSE AND item.scope_version IS NOT NULL
   AND item.sensitivity IN('public','internal','confidential')
   AND item.compartments IS NOT NULL AND item.project_ids IS NOT NULL
   AND agent_visibility_allows(w,item.user_id,item.assistant_id) IS TRUE
   AND workflow_evidence_envelope_visible(w,envelope) IS TRUE
   AND scope_review_state_held('session_message',item.id) IS NOT TRUE;
  result:=result||jsonb_build_array(jsonb_build_object('id',item.id,'sequence',item.sequence_num,'role',item.role,
   'timestamp',item.created_at,'available',coalesce(readable,false),
   'content',CASE WHEN readable THEN (SELECT content FROM session_messages WHERE workspace_id=w AND session_id=i AND id=item.id AND scope_version=item.scope_version) ELSE NULL END));
 END LOOP;
 current_parent:=private_session_display_parent(w,i,device,version);
 IF current_parent IS DISTINCT FROM parent THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('sessionId',i,'workspaceId',w,'mode','personal_transcript_display','rows',result,
  'nextSequence',CASE WHEN more THEN next_sequence ELSE NULL END);
END $$;

REVOKE ALL ON FUNCTION read_private_session_display(uuid,uuid,uuid,integer,integer,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_private_session_display(uuid,uuid,uuid,integer,integer,integer) TO app_user;
END IF;END $$;

-- The immutable legacy cohort retains its original binding/fingerprint and
-- own-envelope checks. A source derivation is not a bar to owner display.
CREATE OR REPLACE FUNCTION read_private_legacy_history(w uuid,i uuid,device uuid,version integer,after_sequence integer,page_size integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 parent jsonb; receipt session_legacy_history; s sessions; item record; envelope jsonb;
 readable boolean; result jsonb:='[]'; next_sequence integer:=NULL; more boolean:=false; seen integer:=0;
BEGIN
 IF after_sequence<0 OR page_size<1 OR page_size>100 OR after_sequence IS NULL OR page_size IS NULL THEN
  RAISE EXCEPTION 'invalid_legacy_history' USING ERRCODE='22023'; END IF;
 -- This existing metadata port enforces non-owner role, native credential,
 -- actual owner/member/assistant and current explicit context authority under locks.
 parent:=private_session_display_parent(w,i,device,version);
 -- Only the transcript and its current audience authorize this read. Lock
 -- policy/review changes through commit, without traversing upstream sources.
 -- NOWAIT avoids a policy/source lock inversion with concurrent mutations.
 BEGIN
  PERFORM singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
  PERFORM workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
  PERFORM workspace_id FROM workspace_access_policies WHERE workspace_id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END;
 SELECT * INTO receipt FROM session_legacy_history WHERE session_id=i AND user_id=actor AND workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'legacy_history_unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM sessions WHERE id=i;
 IF private_legacy_history_binding(s) IS DISTINCT FROM receipt.binding
  OR scope_review_state_held('session',i) IS TRUE THEN
  RAISE EXCEPTION 'legacy_history_unavailable' USING ERRCODE='42501'; END IF;
 FOR item IN
  SELECT m.*,h.fingerprint,h.sequence_num AS frozen_sequence FROM session_legacy_history_messages h
  JOIN session_messages m ON m.id=h.message_id AND m.session_id=h.session_id
  WHERE h.session_id=i AND h.sequence_num>after_sequence
   AND m.role IN('user','assistant')
   AND (jsonb_typeof(m.content)='string' OR jsonb_typeof(m.content)='array'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b
     WHERE b->>'type'='text' AND jsonb_typeof(b->'text')='string'))
   AND NOT (m.role='assistant' AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b WHERE b->>'type'='tool_use'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b WHERE b->>'type'='tool_result')
  ORDER BY h.sequence_num LIMIT page_size+1 FOR SHARE OF m
 LOOP
  seen:=seen+1;
  IF seen>page_size THEN more:=true;EXIT;END IF;
  next_sequence:=item.frozen_sequence;
  readable:=encode(sha256(convert_to((to_jsonb(item)-ARRAY['fingerprint','frozen_sequence'])::text,'UTF8')),'hex')=item.fingerprint
   AND item.role IN('user','assistant') AND item.scope_held IS NOT TRUE
   AND (item.workspace_id IS NULL OR item.workspace_id=w)
   AND (item.user_id IS NULL OR item.user_id=actor)
   AND (item.sender_user_id IS NULL OR item.sender_user_id=actor)
   AND scope_review_state_held('session_message',item.id) IS NOT TRUE
   AND octet_length(item.content::text)<=131072;
  -- Fully absent old envelopes are the display exception. Partial envelopes
  -- and known scoped rows must not be converted into an unclassified grant.
  IF readable AND (item.workspace_id IS NOT NULL OR item.user_id IS NOT NULL OR item.assistant_id IS NOT NULL OR item.sensitivity IS NOT NULL
    OR item.compartments IS NOT NULL OR item.project_ids IS NOT NULL OR item.scope_version IS NOT NULL) THEN
   envelope:=jsonb_build_object('workspaceId',item.workspace_id,'userId',item.user_id,
    'assistantId',item.assistant_id,'sensitivity',item.sensitivity,
    'compartments',item.compartments,'projectIds',item.project_ids);
   readable:=workflow_evidence_envelope_visible(w,envelope) IS TRUE;
  END IF;
  result:=result||jsonb_build_array(jsonb_build_object('id',item.id,'sequence',item.frozen_sequence,
   'role',CASE WHEN item.role IN('user','assistant') THEN item.role ELSE 'assistant' END,
   'timestamp',item.created_at,'available',coalesce(readable,false),
   'content',CASE WHEN readable THEN item.content ELSE NULL END));
 END LOOP;
 -- Recheck clock-dependent native authority after the bounded read too.
 PERFORM private_session_display_parent(w,i,device,version);
 RETURN jsonb_build_object('sessionId',i,'workspaceId',w,'mode','private_legacy_history',
  'rows',result,'nextSequence',CASE WHEN more THEN next_sequence ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION read_private_legacy_history(uuid,uuid,uuid,integer,integer,integer) FROM PUBLIC;
COMMIT;
