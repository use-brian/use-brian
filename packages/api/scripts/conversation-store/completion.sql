-- [COMP:api/native-turn-frame] Fresh completion belongs to the whole physical publication.
CREATE OR REPLACE FUNCTION public.native_turn_complete_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE work native_turn_publication_work;leader native_turn_publication_work;fresh jsonb;item jsonb;message session_messages;d scope_derivations;
 expected_scope jsonb;actual_scope jsonb;actual_payload jsonb;events jsonb;actual_events jsonb;frame_content jsonb;frame_scope jsonb;annotation session_context_scope_revisions;
 members uuid[];cohort_outputs jsonb;commands jsonb;proofs jsonb;ordinal integer:=0;
BEGIN
 SELECT * INTO leader FROM native_turn_publication_work WHERE transaction_id=txid_current() AND frame_id=NEW.frame_id;
 IF leader.frame_id IS NULL OR NEW.transaction_id<>txid_current() OR native_turn_helpers_current() IS NOT TRUE
  OR native_turn_context() IS DISTINCT FROM leader.context OR leader.completion_owner IS NOT NULL AND leader.completion_owner<>leader.frame_id
  OR jsonb_typeof(NEW.outputs) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT array_agg(frame_id ORDER BY frame_id),jsonb_agg(jsonb_build_object('producer','native:turn-frame','sources',original_sources,'target',prepared->'scope')
  ||CASE WHEN prepared ? 'purpose' THEN jsonb_build_object('purpose',prepared->'purpose') ELSE '{}'::jsonb END ORDER BY frame_id)
 INTO members,commands FROM native_turn_publication_work
 WHERE transaction_id=txid_current() AND (leader.completion_owner IS NULL AND frame_id=leader.frame_id OR completion_owner=leader.frame_id);
 IF leader.completion_owner IS NULL THEN
  IF cardinality(members)<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.outputs) n WHERE n ? 'frameId')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 ELSE
  IF cardinality(members)<>2 OR jsonb_array_length(NEW.outputs) NOT BETWEEN 2 AND 513
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.outputs) n WHERE NOT n ? 'frameId' OR NOT (n->>'frameId')::uuid=ANY(members))
   OR (SELECT count(*) FROM jsonb_array_elements(NEW.outputs) n WHERE n->>'kind'='message_annotation')<>1
   OR EXISTS(SELECT 1 FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=ANY(members) AND frame_id<>leader.frame_id)
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END IF;
 -- The independent completion command observes every payload/head mutation.
 proofs:=conversation_prepare_publications(leader.workspace_id,leader.session_id,commands);
 FOR work IN SELECT * FROM native_turn_publication_work WHERE transaction_id=txid_current() AND frame_id=ANY(members) ORDER BY frame_id LOOP
  IF (work.workspace_id,work.session_id,work.context,work.completion_owner) IS DISTINCT FROM
   (leader.workspace_id,leader.session_id,leader.context,leader.completion_owner)
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  SELECT jsonb_agg(n) INTO cohort_outputs FROM jsonb_array_elements(NEW.outputs) n
   WHERE leader.completion_owner IS NULL OR n->>'frameId'=work.frame_id::text;
  IF leader.completion_owner IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(cohort_outputs) n WHERE n ? 'kind')
   AND (jsonb_array_length(cohort_outputs)<>1 OR cohort_outputs->0->>'kind' IS DISTINCT FROM 'message_annotation')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 IF work.frame_id IS NULL OR NEW.transaction_id<>txid_current()
  OR native_turn_context() IS DISTINCT FROM work.context OR native_turn_frame_pair(work.workspace_id,work.frame_id) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM native_turn_publication_debt WHERE transaction_id=txid_current() AND frame_id=work.frame_id)
  OR EXISTS(SELECT 1 FROM native_turn_publication_events WHERE transaction_id=txid_current() AND frame_id=work.frame_id AND NOT fired)
  OR jsonb_typeof(cohort_outputs) IS DISTINCT FROM 'array' OR jsonb_array_length(cohort_outputs) NOT BETWEEN 1 AND 512
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 expected_scope:=work.prepared->'scope';
 SELECT c.content,jsonb_build_object('workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,
  'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids)
 INTO frame_content,frame_scope FROM session_context_scope_revisions r JOIN session_context_revision_contents c
 ON c.workspace_id=r.workspace_id AND c.revision_id=r.id WHERE r.workspace_id=work.workspace_id AND r.id=work.frame_id;
 IF frame_content->'originalSources' IS DISTINCT FROM work.original_sources
  OR frame_content->'declaredSources' IS DISTINCT FROM work.prepared->'retained' OR frame_scope IS DISTINCT FROM expected_scope
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(cohort_outputs) LOOP
  IF item->>'kind' IN('message_annotation','session_title') THEN
   SELECT * INTO annotation FROM session_context_scope_revisions WHERE workspace_id=work.workspace_id AND session_id=work.session_id AND id=(item->>'id')::uuid;
   SELECT * INTO d FROM scope_derivations WHERE workspace_id=work.workspace_id AND id=(item->>'derivationId')::uuid;
   SELECT c.content INTO actual_payload FROM session_context_revision_contents c WHERE c.workspace_id=work.workspace_id AND c.revision_id=annotation.id;
   actual_scope:=jsonb_build_object('workspaceId',annotation.workspace_id,'userId',annotation.user_id,'assistantId',annotation.assistant_id,
    'sensitivity',annotation.sensitivity,'compartments',annotation.compartments,'projectIds',annotation.project_ids);
   IF annotation.id IS NULL OR annotation.parent_kind IS DISTINCT FROM item->>'kind' OR annotation.parent_id::text IS DISTINCT FROM item->>'parentId'
    OR annotation.scope_version<>1 OR annotation.scope_held OR scope_review_state_held('session_context_revision',annotation.id)
    OR actual_scope IS DISTINCT FROM expected_scope OR actual_payload IS NULL OR session_context_payload_shape(item->>'kind',actual_payload) IS NOT TRUE
    OR annotation.payload_sha256 IS DISTINCT FROM item->>'payloadDigest' OR item->>'payloadDigest' IS DISTINCT FROM encode(sha256(convert_to(actual_payload::text,'UTF8')),'hex')
    OR item->>'kind'='message_annotation' AND (NOT EXISTS(SELECT 1 FROM session_messages m JOIN session_message_annotation_heads h ON h.workspace_id=m.workspace_id AND h.session_id=m.session_id AND h.message_id=m.id
     WHERE m.workspace_id=work.workspace_id AND m.session_id=work.session_id AND m.id=annotation.parent_id AND h.scope_revision_id=annotation.id)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(work.original_sources) n WHERE n->>'resourceKind'='session_message' AND n->>'resourceId'=annotation.parent_id::text))
    OR item->>'kind'='session_title' AND (work.prepared->>'purpose' IS DISTINCT FROM 'session_title'
     OR annotation.parent_id IS DISTINCT FROM work.session_id
     OR NOT EXISTS(SELECT 1 FROM session_title_heads h JOIN sessions s ON s.workspace_id=h.workspace_id AND s.id=h.session_id
      WHERE h.workspace_id=work.workspace_id AND h.session_id=work.session_id AND h.scope_revision_id=annotation.id
       AND s.title IS NULL AND s.title_manually_set IS NOT DISTINCT FROM (actual_payload->>'manual')::boolean))
    OR d.id IS NULL OR d.resource_kind IS DISTINCT FROM 'session_context_revision' OR d.resource_id IS DISTINCT FROM annotation.id OR d.resource_version IS DISTINCT FROM '1'
    OR (d.user_id,d.assistant_id,d.sensitivity,d.compartments,d.project_ids) IS DISTINCT FROM
      (annotation.user_id,annotation.assistant_id,annotation.sensitivity,annotation.compartments,annotation.project_ids)
    OR (SELECT count(*) FROM scope_derivation_sources WHERE workspace_id=work.workspace_id AND derivation_id=d.id)<>1
    OR NOT EXISTS(SELECT 1 FROM scope_derivation_sources WHERE workspace_id=work.workspace_id AND derivation_id=d.id AND source_kind='session_context_revision' AND source_id=work.frame_id AND source_version='1')
   THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   CONTINUE;
  END IF;
  IF item ? 'kind' THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  SELECT * INTO message FROM session_messages WHERE workspace_id=work.workspace_id AND session_id=work.session_id AND id=(item->>'id')::uuid;
  SELECT * INTO d FROM scope_derivations WHERE workspace_id=work.workspace_id AND id=(item->>'derivationId')::uuid;
  actual_scope:=jsonb_build_object('workspaceId',message.workspace_id,'userId',message.user_id,'assistantId',message.assistant_id,
   'sensitivity',message.sensitivity,'compartments',message.compartments,'projectIds',message.project_ids);
  actual_payload:=jsonb_build_object('role',message.role,'content',message.content,'channelMessageId',message.channel_message_id,
   'senderUserId',message.sender_user_id,'senderAssistantId',message.sender_assistant_id,'attachments',message.attachments);
  IF message.id IS NULL OR message.scope_held OR scope_review_state_held('session_message',message.id) OR message.scope_version<>1 OR message.sequence_num IS DISTINCT FROM (item->>'sequence')::integer
   OR actual_scope IS DISTINCT FROM expected_scope OR item->>'payloadDigest' IS DISTINCT FROM encode(sha256(convert_to(actual_payload::text,'UTF8')),'hex')
   OR d.id IS NULL OR d.resource_kind IS DISTINCT FROM 'session_message' OR d.resource_id IS DISTINCT FROM message.id OR d.resource_version IS DISTINCT FROM '1'
   OR (d.user_id,d.assistant_id,d.sensitivity,d.compartments,d.project_ids) IS DISTINCT FROM
      (message.user_id,message.assistant_id,message.sensitivity,message.compartments,message.project_ids)
   OR (SELECT count(*) FROM scope_derivation_sources WHERE workspace_id=work.workspace_id AND derivation_id=d.id)<>1
   OR NOT EXISTS(SELECT 1 FROM scope_derivation_sources WHERE workspace_id=work.workspace_id AND derivation_id=d.id
    AND source_kind='session_context_revision' AND source_id=work.frame_id AND source_version='1') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 SELECT jsonb_agg(event ORDER BY event::text) INTO events FROM native_turn_publication_events WHERE transaction_id=txid_current() AND frame_id=work.frame_id;
 SELECT jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text) INTO actual_events FROM scope_derivation_sources e JOIN scope_derivations actual_derivation ON actual_derivation.workspace_id=e.workspace_id AND actual_derivation.id=e.derivation_id
 WHERE actual_derivation.workspace_id=work.workspace_id AND (actual_derivation.resource_kind='session_context_revision' AND actual_derivation.resource_id=work.frame_id
  OR actual_derivation.id IN(SELECT (n->>'derivationId')::uuid FROM jsonb_array_elements(cohort_outputs) n));
 IF events IS NULL OR events IS DISTINCT FROM actual_events THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;

  fresh:=proofs->ordinal;ordinal:=ordinal+1;
  IF fresh IS NULL OR (fresh-'proof') IS DISTINCT FROM work.prepared OR native_turn_context() IS DISTINCT FROM work.context
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF fresh#>>'{proof,validUntil}' IS NULL OR clock_timestamp()>=(fresh#>>'{proof,validUntil}')::timestamptz
  THEN RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 END LOOP;
 IF ordinal<>cardinality(members) OR native_turn_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 UPDATE native_turn_publication_work SET completion_ready=true WHERE transaction_id=txid_current() AND frame_id=ANY(members);
 DELETE FROM native_turn_publication_debt WHERE transaction_id=txid_current() AND frame_id=ANY(members);
 DELETE FROM native_turn_publication_events WHERE transaction_id=txid_current() AND frame_id=ANY(members);
 DELETE FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=leader.frame_id;
 DELETE FROM native_turn_publication_work WHERE transaction_id=txid_current() AND frame_id=ANY(members);
 RETURN NULL;
END $function$;
