CREATE OR REPLACE FUNCTION public.application_session_eval_point_state(w uuid, t text, i uuid, fields text[], memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE m session_messages;revision session_context_scope_revisions;source jsonb;parent jsonb;payload jsonb;values_json jsonb;selected jsonb;
 keys text[]:=application_session_field_keys(t);record_version text;source_kind text;source_id uuid;checked jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 direct_kinds text[];direct_ids uuid[];direct_versions text[];direct_position integer;history_shape boolean:=false;
 dependency record;admitted jsonb;projection jsonb;label jsonb;seen jsonb:='[]';immutable_scope jsonb;
BEGIN
 -- Recording privacy admission precedes body selection.
 IF NOT recording_source_read_allowed(w,'session_message',i) THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF keys IS NULL OR fields IS NULL OR cardinality(fields)>cardinality(keys) OR NOT fields<@keys
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 -- Only immutable identity/scope metadata is selected before source admission.
 SELECT id,workspace_id,session_id,scope_version,sequence_num INTO m.id,m.workspace_id,m.session_id,m.scope_version,m.sequence_num
  FROM session_messages WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 parent:=application_session_query_parent(w,m.session_id);IF parent IS NULL THEN RETURN NULL;END IF;
 IF t='session_message' THEN
  source:=read_admitted_native_scope_snapshot(w,'session_message',i);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM m.scope_version::text
    THEN RETURN NULL;END IF;

  -- Only the first canonical history-bearing message uses complete per-original admission.
  IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO direct_kinds,direct_ids,direct_versions,history_shape
 FROM session_messages message JOIN sessions session ON session.id=message.session_id AND session.workspace_id=message.workspace_id
 JOIN scope_derivations d ON d.workspace_id=message.workspace_id AND d.resource_kind='session_message'
  AND d.resource_id=message.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM message.user_id
  AND d.assistant_id IS NOT DISTINCT FROM message.assistant_id AND d.sensitivity=message.sensitivity
  AND d.compartments=message.compartments AND d.project_ids=message.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE message.workspace_id=w AND message.id=i AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM application_scope_lineage(w,direct_kinds,direct_ids,direct_versions) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=i) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

  END IF;
  IF history_shape IS TRUE THEN
   BEGIN
    IF application_reader_envelope_visible(w,source) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     SELECT o.source_scope INTO immutable_scope FROM application_field_observations o
      WHERE o.workspace_id=w AND o.resource_id=direct_ids[direct_position] AND o.version=direct_versions[direct_position];
     IF immutable_scope IS NULL OR workflow_evidence_envelope_visible(w,immutable_scope) IS NOT TRUE
      OR sensitivity_rank(immutable_scope->>'sensitivity')>sensitivity_rank(source->>'sensitivity')
      OR NOT (source->'compartments')@>(immutable_scope->'compartments') OR NOT (source->'projectIds')@>(immutable_scope->'projectIds')
      OR immutable_scope->>'userId' IS NOT NULL AND immutable_scope->>'userId' IS DISTINCT FROM source->>'userId'
       AND (source->>'userId' IS NOT NULL OR immutable_scope->>'userId' IS DISTINCT FROM actor::text)
      THEN RETURN jsonb_build_object('memo',memo);END IF;
     IF EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
      projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]);
      IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
       OR projection->'root' IS DISTINCT FROM (immutable_scope||jsonb_build_object('resourceKind','application_field','resourceId',direct_ids[direct_position],'version',direct_versions[direct_position]))
       OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN RETURN jsonb_build_object('memo',memo);END IF;
      FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
       IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
      END LOOP;
     ELSE
      -- Ordinary originals retain their stricter exact current-version check.
      checked:=application_session_eval_field(w,direct_ids[direct_position],direct_versions[direct_position],memo);
      memo:=coalesce(checked->'memo',memo);admitted:=checked->'value';
      IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM direct_versions[direct_position]
       THEN RETURN jsonb_build_object('memo',memo);END IF;
     END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     -- The helper admits the complete originals after metadata discovery.
     -- Transitive ordinary fields retain D1; their immutable tuple is not rewritten.
     IF dependency.source IS NULL OR dependency.source->>'resourceKind' IS DISTINCT FROM 'application_field'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
      OR NOT EXISTS(SELECT 1 FROM application_field_observations o WHERE o.workspace_id=w
       AND o.resource_id=(dependency.source->>'resourceId')::uuid AND o.version=dependency.node_version)
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
     seen:=seen||jsonb_build_array(jsonb_build_array(dependency.source->>'resourceId',dependency.node_version));
     IF jsonb_array_length(seen)>4096 THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     IF NOT seen @> jsonb_build_array(jsonb_build_array(direct_ids[direct_position]::text,direct_versions[direct_position])) THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_external_source_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     admitted:=external_source_snapshot(w,(dependency.source->>'resourceId')::uuid);
     IF dependency.source IS NULL OR admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version OR admitted->>'version' IS DISTINCT FROM dependency.node_version
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE OR application_reader_envelope_visible(w,admitted) IS NOT TRUE
      THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    IF read_admitted_native_scope_snapshot(w,'session_message',i) IS DISTINCT FROM source THEN RETURN jsonb_build_object('memo',memo);END IF;
   EXCEPTION WHEN insufficient_privilege THEN RETURN jsonb_build_object('memo',memo);END;
  ELSE
  checked:=application_session_eval_scope(w,'session_message',i,m.scope_version::text,memo);memo:=checked->'memo';
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
  END IF;
  SELECT jsonb_build_object('id',id,'role',role,'content',content,'sequenceNum',sequence_num,'createdAt',created_at,
   'senderUserId',sender_user_id,'senderAssistantId',sender_assistant_id,'channelMessageId',channel_message_id,'attachments',attachments) INTO values_json
   FROM session_messages WHERE workspace_id=w AND id=i AND scope_version=m.scope_version;
  IF values_json IS NULL THEN RETURN NULL;END IF;
  source_kind:='session_message';source_id:=i;
  -- Selected payload changes remain distinct even when an old native writer
  -- changed text without advancing its scope envelope version.
  record_version:=m.scope_version::text||':'||application_field_digest(values_json);
 ELSE
  SELECT r.* INTO revision FROM session_message_annotation_heads h JOIN session_context_scope_revisions r
   ON r.workspace_id=h.workspace_id AND r.id=h.scope_revision_id
   WHERE h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=i AND r.parent_kind='message_annotation'
    AND r.parent_id=i AND r.session_id=m.session_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  checked:=application_session_eval_scope(w,'session_context_revision',revision.id,'1',memo);memo:=checked->'memo';
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
  source:=session_context_revision_native(w,revision.id);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  SELECT content INTO payload FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=revision.id;
  IF payload IS NULL THEN RETURN NULL;END IF;
  values_json:=jsonb_build_object('id',i,'sequenceNum',m.sequence_num,'topicLabel',payload->'topicLabel',
   'topicConfidence',payload->'topicConfidence','replyToText',payload->'replyToText');
  source_kind:='session_context_revision';source_id:=revision.id;record_version:=revision.id::text;
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO selected FROM jsonb_each(values_json) WHERE key=ANY(fields);
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('values',selected,'source',source,'recordVersion',record_version,
  'sourceKind',source_kind,'sourceId',source_id,'sourceVersion',source->>'version','ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',t,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_field_v1','parent',parent->'fingerprint','fields',fields)),
  'references','[]'::jsonb));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $function$
