-- Format2 candidate validation and exact native result binding. No text heuristic.
CREATE FUNCTION public.native_session_turn_publication_state(w uuid,s uuid,t uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r sessions;
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 PERFORM lock_native_session_context_publication(w,s);
 SELECT * INTO r FROM sessions WHERE workspace_id=w AND id=s;
 IF NOT FOUND OR t IS NULL OR r.last_turn_lease_token IS DISTINCT FROM t THEN RETURN 'superseded';END IF;
 IF r.turn_lease_token=t AND r.status='running' THEN
  RETURN CASE WHEN r.cancel_requested_at IS NULL THEN 'active' ELSE 'stopping' END;
 END IF;
 IF r.turn_lease_token IS NULL AND r.turn_end_reason='stopped_by_user' THEN RETURN 'stopped';END IF;
 RETURN 'superseded';
END $body$;

CREATE FUNCTION public.native_conversation_terminal_candidate_valid(candidate jsonb,payloads jsonb,answering uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE m jsonb;row jsonb;previous integer:=-1;ordinal integer;origins text[]:='{}';
BEGIN
 IF candidate IS NULL OR candidate='null'::jsonb THEN RETURN true;END IF;
 IF jsonb_typeof(candidate) IS DISTINCT FROM 'object'
  OR candidate-ARRAY['version','disposition','invocationId','projection','formatter','format','textDigest','members']<>'{}'
  OR NOT candidate ?& ARRAY['version','disposition','invocationId','projection','formatter','format','textDigest','members']
  OR candidate->'version'<>'1'::jsonb OR candidate->>'disposition' IS DISTINCT FROM 'reply'
  OR candidate->>'projection' IS DISTINCT FROM 'persistable_response_v1' OR candidate->>'formatter' IS DISTINCT FROM 'turn_output_v1'
  OR candidate->>'format' NOT IN('compact','channel') OR candidate->>'format' IS NULL
  OR jsonb_typeof(candidate->'invocationId') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(candidate->>'invocationId','uuid') OR length(candidate->>'invocationId')<>36
  OR candidate->>'textDigest' !~ '^[a-f0-9]{64}$' OR candidate->>'textDigest' IS NULL
  OR jsonb_typeof(candidate->'members') IS DISTINCT FROM 'array' OR jsonb_array_length(candidate->'members') NOT BETWEEN 1 AND 512
  OR jsonb_typeof(payloads) IS DISTINCT FROM 'array' OR jsonb_array_length(payloads)>512
 THEN RETURN false;END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(candidate->'members') LOOP
  IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR m-ARRAY['origin','revision','snapshotDigest','contentDigest','commandOrdinal']<>'{}'
   OR NOT m ?& ARRAY['origin','revision','snapshotDigest','contentDigest','commandOrdinal']
   OR jsonb_typeof(m->'origin') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(m->>'origin','uuid') OR length(m->>'origin')<>36 OR m->>'origin'=ANY(origins)
   OR jsonb_typeof(m->'revision') IS DISTINCT FROM 'number' OR NOT pg_input_is_valid(m->>'revision','integer')
   OR jsonb_typeof(m->'commandOrdinal') IS DISTINCT FROM 'number' OR NOT pg_input_is_valid(m->>'commandOrdinal','integer')
   OR m->>'snapshotDigest' !~ '^[a-f0-9]{64}$' OR m->>'snapshotDigest' IS NULL
   OR m->>'contentDigest' !~ '^[a-f0-9]{64}$' OR m->>'contentDigest' IS NULL
  THEN RETURN false;END IF;
  ordinal:=(m->>'commandOrdinal')::integer;
  IF (m->>'revision')::integer<1 OR ordinal<=previous OR ordinal>=jsonb_array_length(payloads) THEN RETURN false;END IF;
  previous:=ordinal;origins:=origins||(m->>'origin');row:=payloads->ordinal;
  IF row->>'role' IS DISTINCT FROM 'assistant' OR row->>'senderAssistantId' IS DISTINCT FROM answering::text
   OR jsonb_typeof(row->'content') IS DISTINCT FROM 'array'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(row->'content') b WHERE b->>'type' IN('tool_use','host_observation'))
  THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $body$;

CREATE FUNCTION public.native_conversation_terminal_subset(descriptor jsonb,selected jsonb,outputs jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE m jsonb;n jsonb;position integer:=0;seen uuid[]:='{}';
BEGIN
 IF descriptor IS NULL THEN RETURN selected IS NULL;END IF;
 IF jsonb_typeof(selected) IS DISTINCT FROM 'array' OR jsonb_array_length(selected)<>jsonb_array_length(descriptor->'members')
  OR jsonb_array_length(selected) NOT BETWEEN 1 AND 512 THEN RETURN false;END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(descriptor->'members') LOOP
  n:=selected->position;position:=position+1;
  IF n-ARRAY['origin','revision','commandOrdinal','kind','id','version','frameId','derivationId','sequence','payloadDigest']<>'{}'
   OR NOT n ?& ARRAY['origin','revision','commandOrdinal','kind','id','version','frameId','derivationId','sequence','payloadDigest']
   OR n->'origin' IS DISTINCT FROM m->'origin' OR n->'revision' IS DISTINCT FROM m->'revision'
   OR n->'commandOrdinal' IS DISTINCT FROM m->'commandOrdinal' OR n->>'kind' IS DISTINCT FROM 'session_message'
   OR NOT pg_input_is_valid(n->>'id','uuid') OR (n->>'id')::uuid=ANY(seen)
   OR (SELECT count(*) FROM jsonb_array_elements(outputs) o WHERE o=n-ARRAY['origin','revision','commandOrdinal'])<>1
  THEN RETURN false;END IF;
  seen:=seen||(n->>'id')::uuid;
 END LOOP;
 RETURN true;
END $body$;

CREATE FUNCTION public.native_conversation_publication_packet(i uuid,value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r native_conversation_publications;
BEGIN
 SELECT * INTO STRICT r FROM native_conversation_publications WHERE id=i;
 IF r.command_format<>2 THEN RETURN value;END IF;
 RETURN jsonb_build_object('value',value,'publication',jsonb_build_object('operationId',r.id,'commandDigest',r.command_digest,
  'requestedStopped',r.requested_stopped,'stopped',r.stopped,'terminalDescriptor',r.terminal_descriptor,'terminalOutputs',r.terminal_outputs));
END $body$;
REVOKE ALL ON FUNCTION public.native_session_turn_publication_state(uuid,uuid,uuid),
 public.native_conversation_terminal_candidate_valid(jsonb,jsonb,uuid),public.native_conversation_terminal_subset(jsonb,jsonb,jsonb),
 public.native_conversation_publication_packet(uuid,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.native_session_turn_publication_state(uuid,uuid,uuid) TO app_user;
