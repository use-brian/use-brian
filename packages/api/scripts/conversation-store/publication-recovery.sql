-- [COMP:api/native-turn-frame] Atomic durable publication, attended shared-web slice.
CREATE TABLE public.native_conversation_publications (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 input_message_id uuid NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
 actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 turn_token uuid NOT NULL,slot text NOT NULL CHECK(slot='buffered_transcript'),
 command_format integer NOT NULL CHECK(command_format IN(1,2)),
 command_digest text NOT NULL CHECK(command_digest~'^[a-f0-9]{64}$'),
 stopped boolean NOT NULL,
 frame_ids uuid[] NOT NULL CHECK(cardinality(frame_ids) BETWEEN 1 AND 2),
 leader_frame_id uuid NOT NULL,
 expected_output_count integer NOT NULL CHECK(expected_output_count BETWEEN 1 AND 513),
 annotation_user_id uuid,annotation_assistant_id uuid,
 outputs jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 requested_stopped boolean,terminal_descriptor jsonb,terminal_outputs jsonb,
 CONSTRAINT native_conversation_terminal_format CHECK(
  command_format=1 AND requested_stopped IS NULL AND terminal_descriptor IS NULL AND terminal_outputs IS NULL
  OR command_format=2 AND requested_stopped IS NOT NULL AND (NOT requested_stopped OR stopped)
   AND (terminal_descriptor IS NULL)=(terminal_outputs IS NULL) AND (NOT stopped OR terminal_descriptor IS NULL)),
 CONSTRAINT native_conversation_publication_slot UNIQUE(workspace_id,session_id,turn_token,slot),
 CONSTRAINT native_conversation_publication_result CHECK((outputs IS NULL)=(completed_at IS NULL))
);
CREATE INDEX native_conversation_publication_discovery ON native_conversation_publications
 (workspace_id,session_id,actor_user_id,assistant_id,created_at,id);
REVOKE ALL ON public.native_conversation_publications FROM PUBLIC,app_user;
ALTER TABLE public.native_conversation_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.native_turn_publication_work ADD COLUMN publication_id uuid;
ALTER TABLE public.native_turn_publication_work ADD CONSTRAINT native_turn_publication_operation
 FOREIGN KEY(publication_id) REFERENCES native_conversation_publications(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- This owner grants neither a serialized invocation nor output delivery authority.
CREATE FUNCTION public.native_conversation_publication_scope(w uuid,s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 assistant uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;parent jsonb;
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 parent:=lock_native_session_context_publication(w,s);
 IF actor IS NULL OR assistant IS NULL OR NOT EXISTS(SELECT 1 FROM sessions r WHERE r.workspace_id=w AND r.id=s AND __WEB_ROOM_PREDICATE__)
  OR NOT EXISTS(SELECT 1 FROM assistants a WHERE a.id=assistant AND a.workspace_id=w)
  OR nullif(current_setting('app.programmatic_candidate',true),'') IS NOT NULL
  OR nullif(current_setting('app.programmatic_publication_batch',true),'') IS NOT NULL
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('actorUserId',actor,'assistantId',assistant);
END $body$;

-- Exact output membership and the independent source graph are both required.
-- NULL proof is unavailable, explicit admitted=false is denied. Neither is absence.
CREATE FUNCTION public.native_conversation_publication_result(w uuid,s uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r native_conversation_publications;scope jsonb;proof jsonb;roots jsonb;item jsonb;message session_messages;
 revision session_context_scope_revisions;payload jsonb;rows jsonb:='[]';annotation jsonb;source jsonb;
BEGIN
 scope:=native_conversation_publication_scope(w,s);
 SELECT * INTO r FROM native_conversation_publications WHERE workspace_id=w AND session_id=s AND id=i
  AND actor_user_id=(scope->>'actorUserId')::uuid AND assistant_id=(scope->>'assistantId')::uuid;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','unknown');END IF;
 IF r.completed_at IS NULL OR jsonb_typeof(r.outputs) IS DISTINCT FROM 'array' OR jsonb_array_length(r.outputs)<>r.expected_output_count
 THEN RETURN jsonb_build_object('state','unavailable','reason','publication_incomplete');END IF;
 IF EXISTS(SELECT 1 FROM unnest(r.frame_ids) frame WHERE native_turn_frame_pair(w,frame) IS NOT TRUE)
 THEN RETURN jsonb_build_object('state','unavailable','reason','publication_frame_changed');END IF;
 SELECT jsonb_agg(DISTINCT value) INTO roots FROM (
  SELECT jsonb_build_object('kind','session_context_revision','id',frame,'version','1') value FROM unnest(r.frame_ids) frame
  UNION ALL SELECT jsonb_build_object('kind',CASE WHEN n->>'kind'='message_annotation' THEN 'session_context_revision' ELSE 'session_message' END,
   'id',n->'id','version','1') FROM jsonb_array_elements(r.outputs) n
 ) members;
 proof:=capture_conversation_evidence(w,roots);
 IF proof IS NULL THEN RETURN jsonb_build_object('state','unavailable','reason','source_proof_unavailable');END IF;
 IF proof->>'admitted' IS DISTINCT FROM 'true' THEN
  IF proof->>'admitted'='false' THEN RETURN jsonb_build_object('state','denied','reason','source_access_denied');END IF;
  RETURN jsonb_build_object('state','unavailable','reason','source_proof_unavailable');
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(r.outputs) ORDER BY coalesce((value->>'sequence')::integer,0),value->>'id' LOOP
  IF NOT (item->>'frameId')::uuid=ANY(r.frame_ids) THEN RETURN jsonb_build_object('state','unavailable','reason','publication_member_changed');END IF;
  IF item->>'kind'='session_message' THEN
   SELECT * INTO message FROM session_messages WHERE workspace_id=w AND session_id=s AND id=(item->>'id')::uuid;
   payload:=jsonb_build_object('role',message.role,'content',message.content,'channelMessageId',message.channel_message_id,
    'senderUserId',message.sender_user_id,'senderAssistantId',message.sender_assistant_id,'attachments',message.attachments);
   IF message.id IS NULL OR message.scope_version<>1 OR message.scope_held OR message.sequence_num<>(item->>'sequence')::integer
    OR item->>'version'<>'1' OR item->>'payloadDigest' IS DISTINCT FROM encode(sha256(convert_to(payload::text,'UTF8')),'hex')
    OR NOT EXISTS(SELECT 1 FROM scope_derivations d JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id
     WHERE d.workspace_id=w AND d.id=(item->>'derivationId')::uuid AND d.resource_kind='session_message' AND d.resource_id=message.id
     AND d.resource_version='1' AND e.source_kind='session_context_revision' AND e.source_id=(item->>'frameId')::uuid AND e.source_version='1')
   THEN RETURN jsonb_build_object('state','unavailable','reason','publication_member_changed');END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',message.user_id,'assistantId',message.assistant_id,'sensitivity',message.sensitivity,
    'compartments',message.compartments,'projectIds',message.project_ids,'resourceKind','session_message','resourceId',message.id,'version','1');
   rows:=rows||jsonb_build_array(jsonb_build_object('message',jsonb_build_object('id',message.id,'sessionId',s,'role',message.role,'content',message.content,
    'sequenceNum',message.sequence_num,'createdAt',message.created_at,'replyToText',NULL,'topicLabel',NULL,'topicConfidence',NULL,
    'channelMessageId',message.channel_message_id,'senderUserId',message.sender_user_id,'senderAssistantId',message.sender_assistant_id,'attachments',message.attachments),'source',source));
  ELSIF item->>'kind'='message_annotation' THEN
   SELECT * INTO revision FROM session_context_scope_revisions WHERE workspace_id=w AND session_id=s AND id=(item->>'id')::uuid;
   SELECT content INTO payload FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=revision.id;
   IF revision.id IS NULL OR revision.parent_kind<>'message_annotation' OR revision.parent_id::text IS DISTINCT FROM item->>'parentId'
    OR revision.scope_version<>1 OR revision.scope_held OR item->>'version'<>'1'
    OR item->>'payloadDigest' IS DISTINCT FROM encode(sha256(convert_to(payload::text,'UTF8')),'hex')
    OR NOT EXISTS(SELECT 1 FROM scope_derivations d JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id
     WHERE d.workspace_id=w AND d.id=(item->>'derivationId')::uuid AND d.resource_kind='session_context_revision' AND d.resource_id=revision.id
     AND d.resource_version='1' AND e.source_kind='session_context_revision' AND e.source_id=(item->>'frameId')::uuid AND e.source_version='1')
   THEN RETURN jsonb_build_object('state','unavailable','reason','publication_member_changed');END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',revision.user_id,'assistantId',revision.assistant_id,'sensitivity',revision.sensitivity,
    'compartments',revision.compartments,'projectIds',revision.project_ids,'resourceKind','session_context_revision','resourceId',revision.id,'version','1');
   annotation:=jsonb_build_object('source',source,'createdAt',revision.created_at,'userId',r.annotation_user_id,'assistantId',r.annotation_assistant_id);
  ELSE RETURN jsonb_build_object('state','unavailable','reason','publication_member_changed');END IF;
 END LOOP;
 RETURN jsonb_build_object('state','committed','outputs',r.outputs,'value',CASE WHEN annotation IS NULL THEN rows ELSE jsonb_build_object('messages',rows,'annotation',annotation) END);
END $body$;

-- Private pre-write identity/digest validation. It cannot register or capture a result.
CREATE FUNCTION public.native_conversation_publication_enter(w uuid,s uuid,operation jsonb,command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE scope jsonb;r native_conversation_publications;digest text;result jsonb;payloads jsonb;node jsonb;version integer;state text;effective_stopped boolean;
BEGIN
 scope:=native_conversation_publication_scope(w,s);
 version:=CASE operation->'version' WHEN '1'::jsonb THEN 1 WHEN '2'::jsonb THEN 2 END;
 IF version IS NULL OR jsonb_typeof(operation) IS DISTINCT FROM 'object'
  OR operation-(ARRAY['version','operationId','inputMessageId','actorUserId','assistantId','turnToken','slot','stopped']||CASE WHEN version=2 THEN ARRAY['terminalCandidate'] ELSE '{}'::text[] END)<>'{}'
  OR NOT operation ?& (ARRAY['version','operationId','inputMessageId','actorUserId','assistantId','turnToken','slot','stopped']||CASE WHEN version=2 THEN ARRAY['terminalCandidate'] ELSE '{}'::text[] END)
  OR operation->>'slot' IS DISTINCT FROM 'buffered_transcript' OR jsonb_typeof(operation->'stopped') IS DISTINCT FROM 'boolean'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','inputMessageId','actorUserId','assistantId','turnToken']) key
   WHERE jsonb_typeof(operation->key) IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(operation->>key,'uuid'))
  OR jsonb_typeof(command) IS DISTINCT FROM 'object' OR command-ARRAY['payloads','producer','sources','target']<>'{}'
  OR NOT command ?& ARRAY['payloads','producer','sources','target']
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 IF operation->>'actorUserId' IS DISTINCT FROM scope->>'actorUserId' OR operation->>'assistantId' IS DISTINCT FROM scope->>'assistantId'
  OR NOT EXISTS(SELECT 1 FROM session_messages m WHERE m.workspace_id=w AND m.session_id=s AND m.id=(operation->>'inputMessageId')::uuid
   AND m.role='user' AND m.sender_user_id=(scope->>'actorUserId')::uuid)
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 payloads:=command->'payloads';
 IF jsonb_typeof(payloads)='object' THEN
  IF payloads-ARRAY['messages','annotation']<>'{}' OR NOT payloads ?& ARRAY['messages','annotation']
   OR jsonb_typeof(payloads->'annotation') IS DISTINCT FROM 'object'
   OR (payloads->'annotation')-ARRAY['kind','parentId','id','content','producer','sources','expectedRevision','expectedGeneration']<>'{}'
   OR NOT (payloads->'annotation') ?& ARRAY['parentId','id','content','producer','sources','expectedRevision','expectedGeneration']
   OR jsonb_typeof(payloads#>'{annotation,sources}') IS DISTINCT FROM 'array'
   OR payloads#>>'{annotation,kind}' IS NOT NULL AND payloads#>>'{annotation,kind}'<>'message_annotation'
   OR payloads#>>'{annotation,parentId}' IS DISTINCT FROM operation->>'inputMessageId'
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  payloads:=payloads->'messages';
 END IF;
 IF jsonb_typeof(payloads) IS DISTINCT FROM 'array' OR jsonb_array_length(payloads)>512
  OR jsonb_array_length(payloads)=0 AND jsonb_typeof(command->'payloads')<>'object'
  OR jsonb_typeof(command->'sources') IS DISTINCT FROM 'array'
  OR jsonb_typeof(command->'target') IS DISTINCT FROM 'object'
  OR (command->'target')-ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']<>'{}'
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(command->'sources')
  UNION ALL SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(command->'payloads')='object' THEN command#>'{payloads,annotation,sources}' ELSE '[]'::jsonb END)
 LOOP
  IF jsonb_typeof(node) IS DISTINCT FROM 'object'
   OR NOT node ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds','resourceKind','resourceId','version']
   OR node-ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds','resourceKind','resourceId','version']<>'{}'
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF version=2 AND native_conversation_terminal_candidate_valid(operation->'terminalCandidate',payloads,(operation->>'assistantId')::uuid) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 digest:=encode(sha256(convert_to(jsonb_build_object('format',version,'workspaceId',w,'sessionId',s,'operation',operation,'command',command)::text,'UTF8')),'hex');
 SELECT * INTO r FROM native_conversation_publications WHERE id=(operation->>'operationId')::uuid
  OR workspace_id=w AND session_id=s AND turn_token=(operation->>'turnToken')::uuid AND slot='buffered_transcript' FOR UPDATE;
 IF FOUND THEN
  IF r.id<>(operation->>'operationId')::uuid OR r.workspace_id<>w OR r.session_id<>s OR r.input_message_id<>(operation->>'inputMessageId')::uuid
   OR r.actor_user_id<>(scope->>'actorUserId')::uuid OR r.assistant_id<>(scope->>'assistantId')::uuid OR r.turn_token<>(operation->>'turnToken')::uuid OR r.command_digest<>digest
   OR r.command_format<>version OR version=1 AND r.stopped IS DISTINCT FROM (operation->>'stopped')::boolean
   OR version=2 AND r.requested_stopped IS DISTINCT FROM (operation->>'stopped')::boolean
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  result:=native_conversation_publication_result(w,s,r.id);
  IF result->>'state'<>'committed' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  RETURN jsonb_build_object('duplicate',true,'value',CASE WHEN version=2 THEN native_conversation_publication_packet(r.id,result->'value') ELSE result->'value' END);
 END IF;
 IF version=2 THEN
  state:=native_session_turn_publication_state(w,s,(operation->>'turnToken')::uuid);
  IF state NOT IN('active','stopping','stopped') THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  effective_stopped:=(operation->>'stopped')::boolean OR state IN('stopping','stopped');
 ELSE
  IF native_session_turn_publication_allowed(w,s,(operation->>'turnToken')::uuid,(operation->>'stopped')::boolean) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  effective_stopped:=(operation->>'stopped')::boolean;
 END IF;
 RETURN jsonb_build_object('duplicate',false,'digest',digest,'effectiveStopped',effective_stopped);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';
END $body$;

CREATE FUNCTION public.native_conversation_publication_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r native_conversation_publications;
BEGIN
 SELECT * INTO r FROM native_conversation_publications WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NULL;END IF; -- an authorized cascading erasure owns deletion
 IF r.outputs IS NULL OR r.completed_at IS NULL OR jsonb_typeof(r.outputs) IS DISTINCT FROM 'array'
  OR jsonb_array_length(r.outputs)<>r.expected_output_count OR NOT r.leader_frame_id=ANY(r.frame_ids)
  OR cardinality(r.frame_ids)<>(SELECT count(DISTINCT value) FROM unnest(r.frame_ids) value)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.outputs) n WHERE NOT (n->>'frameId')::uuid=ANY(r.frame_ids))
  OR r.command_format=2 AND (r.stopped AND r.terminal_descriptor IS NOT NULL
   OR native_conversation_terminal_subset(r.terminal_descriptor,r.terminal_outputs,r.outputs) IS NOT TRUE)
  OR native_turn_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER native_conversation_publication_complete AFTER INSERT ON native_conversation_publications
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION native_conversation_publication_complete();

CREATE FUNCTION public.read_native_conversation_publications(w uuid,s uuid,after jsonb DEFAULT NULL,maximum integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE scope jsonb;cursor_at timestamptz;cursor_id uuid;r native_conversation_publications;result jsonb;items jsonb:='[]';next_cursor jsonb;count integer:=0;diagnostic text;
BEGIN
 scope:=native_conversation_publication_scope(w,s);
 IF maximum IS NULL OR maximum NOT BETWEEN 1 AND 50 OR after IS NOT NULL AND
  (jsonb_typeof(after) IS DISTINCT FROM 'object' OR after-ARRAY['createdAt','operationId']<>'{}' OR NOT after ?& ARRAY['createdAt','operationId']
   OR jsonb_typeof(after->'createdAt') IS DISTINCT FROM 'string' OR jsonb_typeof(after->'operationId') IS DISTINCT FROM 'string'
   OR NOT pg_input_is_valid(after->>'createdAt','timestamptz') OR NOT pg_input_is_valid(after->>'operationId','uuid'))
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 IF after IS NOT NULL THEN cursor_at:=(after->>'createdAt')::timestamptz;cursor_id:=(after->>'operationId')::uuid;END IF;
 FOR r IN SELECT * FROM native_conversation_publications WHERE workspace_id=w AND session_id=s
  AND actor_user_id=(scope->>'actorUserId')::uuid AND assistant_id=(scope->>'assistantId')::uuid
  AND (after IS NULL OR (created_at,id)<(cursor_at,cursor_id)) ORDER BY created_at DESC,id DESC LIMIT maximum+1
 LOOP
  count:=count+1;IF count>maximum THEN EXIT;END IF;
  BEGIN
   result:=native_conversation_publication_result(w,s,r.id)-'value';
   IF result->>'state'='unknown' THEN result:=jsonb_build_object('state','unavailable','reason','publication_changed');END IF;
  EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '22023' OR lock_not_available THEN
   GET STACKED DIAGNOSTICS diagnostic=RETURNED_SQLSTATE;
   result:=jsonb_build_object('state','unavailable','reason','source_proof_unavailable:'||diagnostic);
  END;
  items:=items||jsonb_build_array(result||jsonb_build_object('operationId',r.id,'inputMessageId',r.input_message_id,'assistantId',r.assistant_id));
  next_cursor:=jsonb_build_object('createdAt',r.created_at,'operationId',r.id);
 END LOOP;
 IF count<=maximum THEN next_cursor:=NULL;END IF;
 RETURN jsonb_build_object('version',1,'scope',scope,'items',items,'nextCursor',next_cursor);
END $body$;
REVOKE ALL ON FUNCTION native_conversation_publication_scope(uuid,uuid),native_conversation_publication_result(uuid,uuid,uuid),
 native_conversation_publication_enter(uuid,uuid,jsonb,jsonb),native_conversation_publication_complete(),
 read_native_conversation_publications(uuid,uuid,jsonb,integer) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION read_native_conversation_publications(uuid,uuid,jsonb,integer) TO app_user;
CREATE FUNCTION public.native_conversation_publication_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['outputs','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['outputs','completed_at'])
  OR OLD.outputs IS NOT NULL OR NEW.outputs IS NULL OR NEW.completed_at IS NULL
  OR NOT EXISTS(SELECT 1 FROM native_turn_publication_work work JOIN native_turn_publication_seals seal
   ON seal.transaction_id=work.transaction_id AND seal.frame_id=work.frame_id
   WHERE work.transaction_id=txid_current() AND work.frame_id=OLD.leader_frame_id AND work.publication_id=OLD.id
    AND work.workspace_id=OLD.workspace_id AND work.session_id=OLD.session_id AND work.context=native_turn_context())
  OR native_turn_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION native_conversation_publication_immutable() FROM PUBLIC,app_user;
CREATE TRIGGER native_conversation_publication_immutable BEFORE UPDATE ON native_conversation_publications
 FOR EACH ROW EXECUTE FUNCTION native_conversation_publication_immutable();
