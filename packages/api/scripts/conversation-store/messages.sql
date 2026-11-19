-- [COMP:api/native-turn-frame] One publication owner for an annotation and transcript.
CREATE OR REPLACE FUNCTION public.publish_native_session_message_batch(w uuid,s uuid,payloads jsonb,producer text,sources jsonb,target jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET plan_cache_mode=force_generic_plan AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;payload jsonb;node jsonb;
 envelope boolean:=jsonb_typeof(payloads)='object';annotation_command jsonb;session_row sessions;previous uuid;
 a_kind text:='message_annotation';a_parent uuid;a_id uuid;a_payload jsonb;a_producer text;a_sources jsonb;a_revision uuid;a_generation bigint;a_target jsonb;
 commands jsonb:='[]';prepared jsonb;a_prepared jsonb;t_prepared jsonb;
 a_frame uuid:=gen_random_uuid();t_frame uuid:=gen_random_uuid();leader uuid;compound boolean;
 a_frame_payload jsonb;t_frame_payload jsonb;a_scope jsonb;t_scope jsonb;a_retained jsonb;t_retained jsonb;
 a_tier text;t_tier text;a_teams text[];t_teams text[];a_projects uuid[];t_projects uuid[];
 next_sequence integer;results jsonb;annotation_result jsonb;
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF envelope THEN
  IF payloads-ARRAY['messages','annotation']<>'{}' OR NOT payloads ?& ARRAY['messages','annotation']
   OR jsonb_typeof(payloads->'annotation') IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  annotation_command:=payloads->'annotation';payloads:=payloads->'messages';
  IF annotation_command-ARRAY['kind','parentId','id','content','producer','sources','expectedRevision','expectedGeneration']<>'{}'
   OR NOT annotation_command ?& ARRAY['parentId','id','content','producer','sources','expectedRevision','expectedGeneration']
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF annotation_command ? 'kind' THEN a_kind:=annotation_command->>'kind';END IF;
  IF a_kind IS NULL OR a_kind NOT IN('message_annotation','session_title')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  a_parent:=(annotation_command->>'parentId')::uuid;a_id:=(annotation_command->>'id')::uuid;
  a_payload:=annotation_command->'content';a_producer:=annotation_command->>'producer';a_sources:=annotation_command->'sources';
  a_revision:=(annotation_command->>'expectedRevision')::uuid;a_generation:=(annotation_command->>'expectedGeneration')::bigint;
 END IF;
 IF jsonb_typeof(payloads) IS DISTINCT FROM 'array' OR jsonb_array_length(payloads)>512
  OR jsonb_array_length(payloads)=0 AND annotation_command IS NULL
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 parent:=lock_native_session_context_publication(w,s);
 IF annotation_command IS NOT NULL THEN
 IF a_parent IS NULL OR a_id IS NULL OR session_context_payload_shape(a_kind,a_payload) IS NOT TRUE
  OR length(btrim(a_producer)) NOT BETWEEN 1 AND 256
  OR jsonb_typeof(a_sources) IS DISTINCT FROM 'array' OR jsonb_array_length(a_sources) NOT BETWEEN 1 AND 4096
  OR (SELECT count(DISTINCT(n->>'resourceKind',n->>'resourceId')) FROM jsonb_array_elements(a_sources) n)<>jsonb_array_length(a_sources)
  OR a_kind='session_title' AND jsonb_array_length(payloads)<>0
  OR a_kind='message_annotation' AND (NOT EXISTS(SELECT 1 FROM session_messages WHERE workspace_id=w AND session_id=s AND id=a_parent)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a_sources) n WHERE n->>'resourceKind'='session_message' AND n->>'resourceId'=a_parent::text))
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT session_row FROM sessions WHERE workspace_id=w AND id=s;
 IF a_kind='session_title' THEN
  IF a_parent<>s OR (a_payload->>'manual')::boolean IS FALSE AND session_row.title_manually_set THEN
   RETURN jsonb_build_object('messages','[]'::jsonb,'annotation',NULL);END IF;
  SELECT scope_revision_id INTO previous FROM session_title_heads WHERE workspace_id=w AND session_id=s;
 ELSE
  SELECT scope_revision_id INTO previous FROM session_message_annotation_heads WHERE workspace_id=w AND session_id=s AND message_id=a_parent;
 END IF;
 IF a_generation IS NOT NULL AND session_row.session_context_generation<>a_generation OR previous IS DISTINCT FROM a_revision
 THEN RETURN jsonb_build_object('messages','[]'::jsonb,'annotation',NULL);END IF;
 SELECT jsonb_agg(jsonb_build_object('workspaceId',n->'workspaceId','userId',n->'userId','assistantId',n->'assistantId',
  'sensitivity',n->'sensitivity','compartments',n->'compartments','projectIds',n->'projectIds',
  'resourceKind',n->'resourceKind','resourceId',n->'resourceId','version',n->'version') ORDER BY ordinal)
 INTO a_sources FROM jsonb_array_elements(a_sources) WITH ORDINALITY original(n,ordinal);

  a_target:=jsonb_build_object('workspaceId',w,'userId',parent->'userId','assistantId',NULL,'sensitivity',parent->'sensitivity','compartments',parent->'compartments','projectIds',parent->'projectIds');
  commands:=commands||jsonb_build_array(jsonb_build_object('producer',a_producer,'sources',a_sources,'target',a_target)
   ||CASE WHEN a_kind='session_title' THEN jsonb_build_object('purpose',a_kind) ELSE '{}'::jsonb END);
 END IF;
 FOR payload IN SELECT value FROM jsonb_array_elements(payloads) LOOP
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR NOT payload ?& ARRAY['role','content','channelMessageId','senderUserId','senderAssistantId','attachments']
  OR payload-ARRAY['role','content','channelMessageId','senderUserId','senderAssistantId','attachments']<>'{}'
  OR payload->>'role' NOT IN('user','assistant') OR jsonb_typeof(payload->'role') IS DISTINCT FROM 'string'
  OR jsonb_typeof(payload->'attachments') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'attachments')>100
  OR jsonb_typeof(payload->'channelMessageId') NOT IN('null','string')
  OR jsonb_typeof(payload->'senderUserId') NOT IN('null','string') OR jsonb_typeof(payload->'senderAssistantId') NOT IN('null','string')
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR entity_derivation_envelope_valid(target) IS NOT TRUE OR target->>'workspaceId' IS DISTINCT FROM w::text
  OR target->>'assistantId' IS NOT NULL OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId'
  OR payload->>'senderUserId' IS NOT NULL AND payload->>'senderUserId' IS DISTINCT FROM actor::text
  OR payload->>'senderAssistantId' IS NOT NULL AND (payload->>'role'<>'assistant'
   OR payload->>'senderAssistantId' IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF jsonb_array_length(payloads)>0 THEN
 SELECT jsonb_agg(jsonb_build_object('workspaceId',n->'workspaceId','userId',n->'userId','assistantId',n->'assistantId',
  'sensitivity',n->'sensitivity','compartments',n->'compartments','projectIds',n->'projectIds',
  'resourceKind',n->'resourceKind','resourceId',n->'resourceId','version',n->'version') ORDER BY ordinal)
 INTO sources FROM jsonb_array_elements(sources) WITH ORDINALITY original(n,ordinal);
 commands:=commands||jsonb_build_array(jsonb_build_object('producer',producer,'sources',sources,'target',target));
 END IF;
 prepared:=conversation_prepare_publications(w,s,commands);
 IF prepared IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF annotation_command IS NOT NULL THEN
  a_prepared:=prepared->0;a_scope:=a_prepared->'scope';a_retained:=a_prepared->'retained';a_tier:=a_scope->>'sensitivity';
  a_teams:=ARRAY(SELECT jsonb_array_elements_text(a_scope->'compartments'));a_projects:=ARRAY(SELECT jsonb_array_elements_text(a_scope->'projectIds')::uuid);
  a_frame_payload:=jsonb_build_object('kind','native_turn_frame_v2','originalSources',a_sources,'declaredSources',a_retained);
 END IF;
 IF jsonb_array_length(payloads)>0 THEN
  t_prepared:=prepared->(jsonb_array_length(prepared)-1);t_scope:=t_prepared->'scope';t_retained:=t_prepared->'retained';t_tier:=t_scope->>'sensitivity';
  t_teams:=ARRAY(SELECT jsonb_array_elements_text(t_scope->'compartments'));t_projects:=ARRAY(SELECT jsonb_array_elements_text(t_scope->'projectIds')::uuid);
  t_frame_payload:=jsonb_build_object('kind','native_turn_frame_v2','originalSources',sources,'declaredSources',t_retained);
 END IF;
 FOR payload IN SELECT value FROM jsonb_array_elements(payloads) LOOP
 FOR node IN SELECT value FROM jsonb_array_elements(payload->'attachments') LOOP
  IF jsonb_typeof(node) IS DISTINCT FROM 'object' OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t_retained) input WHERE input->>'resourceKind'='workspace_file' AND input->>'resourceId'=node->>'fileId') THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 END LOOP;

 compound:=annotation_command IS NOT NULL AND jsonb_array_length(payloads)>0;
 leader:=CASE WHEN jsonb_array_length(payloads)>0 THEN t_frame ELSE a_frame END;
 INSERT INTO native_turn_publication_work(transaction_id,workspace_id,frame_id,session_id,context,original_sources,prepared,completion_owner)
 SELECT txid_current(),w,a_frame,s,native_turn_context(),a_sources,a_prepared-'proof',CASE WHEN compound THEN leader END WHERE annotation_command IS NOT NULL
 UNION ALL SELECT txid_current(),w,t_frame,s,native_turn_context(),sources,t_prepared-'proof',CASE WHEN compound THEN leader END WHERE jsonb_array_length(payloads)>0;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 SELECT coalesce(max(sequence_num),0) INTO next_sequence FROM session_messages WHERE session_id=s;
 WITH a_frame_revision AS (
  INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  SELECT a_frame,w,s,'turn_frame',a_frame,(a_scope->>'userId')::uuid,NULL,a_tier,a_teams,a_projects,encode(sha256(convert_to(a_frame_payload::text,'UTF8')),'hex') WHERE annotation_command IS NOT NULL RETURNING id
 ), a_frame_record AS (
  INSERT INTO native_turn_frames(workspace_id,id,session_id,format,manifest_digest)
  SELECT id_workspace,id_frame,s,2,encode(sha256(convert_to(a_frame_payload::text,'UTF8')),'hex') FROM (SELECT w id_workspace,id id_frame FROM a_frame_revision) ready RETURNING id
 ), a_frame_contents AS (
  INSERT INTO session_context_revision_contents(workspace_id,revision_id,content)
  SELECT w,id,a_frame_payload FROM a_frame_record RETURNING revision_id
 ), a_frame_declaration AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',a_frame,'1',a_producer,(a_scope->>'userId')::uuid,NULL,a_tier,a_teams,a_projects,revision
  FROM workspace_access_policies CROSS JOIN(SELECT count(*) FROM a_frame_contents) ready WHERE workspace_id=w AND annotation_command IS NOT NULL RETURNING id
 ), a_frame_edges AS (
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,d.id,n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version' FROM a_frame_declaration d CROSS JOIN jsonb_array_elements(a_retained) n
  ORDER BY n->>'resourceKind',n->>'resourceId' RETURNING derivation_id
 ), a_annotation AS (
  INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  SELECT a_id,w,s,a_kind,a_parent,(a_scope->>'userId')::uuid,NULL,a_tier,a_teams,a_projects,encode(sha256(convert_to(a_payload::text,'UTF8')),'hex')
  FROM(SELECT count(*) FROM a_frame_edges) ready WHERE annotation_command IS NOT NULL RETURNING id,created_at
 ), a_annotation_content AS (
  INSERT INTO session_context_revision_contents(workspace_id,revision_id,content) SELECT w,id,a_payload FROM a_annotation RETURNING revision_id
 ), a_head AS (
  INSERT INTO session_message_annotation_heads(message_id,workspace_id,session_id,scope_revision_id)
  SELECT a_parent,w,s,revision_id FROM a_annotation_content WHERE a_kind='message_annotation' ON CONFLICT(message_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id RETURNING message_id
 ), a_title_head AS (
  INSERT INTO session_title_heads(workspace_id,session_id,scope_revision_id)
  SELECT w,s,revision_id FROM a_annotation_content WHERE a_kind='session_title'
  ON CONFLICT(session_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id RETURNING session_id
 ), a_generation AS (
  UPDATE sessions SET session_context_generation=session_context_generation+1,
   title=CASE WHEN a_kind='session_title' THEN NULL ELSE title END,
   title_manually_set=CASE WHEN a_kind='session_title' THEN (a_payload->>'manual')::boolean ELSE title_manually_set END
  FROM(SELECT count(*) FROM a_head) ready CROSS JOIN(SELECT count(*) FROM a_title_head) title_ready
  WHERE workspace_id=w AND id=s AND annotation_command IS NOT NULL RETURNING id
 ), a_declaration AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',a_id,'1',a_producer,(a_scope->>'userId')::uuid,NULL,a_tier,a_teams,a_projects,revision
  FROM workspace_access_policies CROSS JOIN(SELECT count(*) FROM a_generation) ready WHERE workspace_id=w AND annotation_command IS NOT NULL RETURNING id
 ), a_annotation_edge AS (
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,id,'session_context_revision',a_frame,'1' FROM a_declaration RETURNING derivation_id
 ), t_frame_revision AS (
  INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  SELECT t_frame,w,s,'turn_frame',t_frame,(t_scope->>'userId')::uuid,NULL,t_tier,t_teams,t_projects,encode(sha256(convert_to(t_frame_payload::text,'UTF8')),'hex') WHERE jsonb_array_length(payloads)>0 RETURNING id
 ), t_frame_record AS (
  INSERT INTO native_turn_frames(workspace_id,id,session_id,format,manifest_digest)
  SELECT w,id,s,2,encode(sha256(convert_to(t_frame_payload::text,'UTF8')),'hex') FROM t_frame_revision RETURNING id
 ), t_frame_contents AS (
  INSERT INTO session_context_revision_contents(workspace_id,revision_id,content)
  SELECT w,id,t_frame_payload FROM t_frame_record RETURNING revision_id
 ), t_frame_declaration AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',t_frame,'1',producer,(t_scope->>'userId')::uuid,NULL,t_tier,t_teams,t_projects,revision
  FROM workspace_access_policies CROSS JOIN(SELECT count(*) FROM t_frame_contents) ready WHERE workspace_id=w AND jsonb_array_length(payloads)>0 RETURNING id
 ), t_frame_edges AS (
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,d.id,n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version' FROM t_frame_declaration d CROSS JOIN jsonb_array_elements(t_retained) n
  ORDER BY n->>'resourceKind',n->>'resourceId' RETURNING derivation_id
 ), t_written AS (
  INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,sender_user_id,sender_assistant_id,attachments,
   workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
  SELECT s,n.value->>'role',n.value->'content',next_sequence+n.ordinality,n.value->>'channelMessageId',
   (n.value->>'senderUserId')::uuid,(n.value->>'senderAssistantId')::uuid,n.value->'attachments',w,(target->>'userId')::uuid,NULL,t_tier,t_teams,t_projects,1,false
  FROM jsonb_array_elements(payloads) WITH ORDINALITY n(value,ordinality) CROSS JOIN(SELECT count(*) FROM t_frame_edges) ready
  ORDER BY n.ordinality RETURNING *
 ), t_declarations AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_message',m.id,'1',producer,(target->>'userId')::uuid,NULL,t_tier,t_teams,t_projects,p.revision
  FROM t_written m CROSS JOIN workspace_access_policies p WHERE p.workspace_id=w RETURNING id,resource_id
 ), t_message_edges AS (
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,id,'session_context_revision',t_frame,'1' FROM t_declarations RETURNING derivation_id
 ), output_rows AS (
  SELECT a_frame frame_id,jsonb_build_object('kind',a_kind,'id',a_id,'parentId',a_parent,'derivationId',d.id,
   'payloadDigest',encode(sha256(convert_to(a_payload::text,'UTF8')),'hex')) value
  FROM a_declaration d CROSS JOIN(SELECT count(*) FROM a_annotation_edge) ready
  UNION ALL SELECT t_frame,jsonb_build_object('id',m.id,'derivationId',d.id,'sequence',m.sequence_num,
   'payloadDigest',encode(sha256(convert_to(jsonb_build_object('role',m.role,'content',m.content,'channelMessageId',m.channel_message_id,
    'senderUserId',m.sender_user_id,'senderAssistantId',m.sender_assistant_id,'attachments',m.attachments)::text,'UTF8')),'hex'))
  FROM t_written m JOIN t_declarations d ON d.resource_id=m.id CROSS JOIN(SELECT count(*) FROM t_message_edges) ready
 ), seal AS (
  INSERT INTO native_turn_publication_seals(transaction_id,frame_id,outputs)
  SELECT txid_current(),leader,jsonb_agg(value||CASE WHEN compound THEN jsonb_build_object('frameId',frame_id) ELSE '{}'::jsonb END ORDER BY frame_id,value::text) FROM output_rows
  RETURNING native_turn_publication_seals.transaction_id,native_turn_publication_seals.frame_id
 ), debt AS (
  INSERT INTO native_turn_publication_debt SELECT seal.transaction_id,o.frame_id FROM seal CROSS JOIN(SELECT DISTINCT frame_id FROM output_rows) o
  RETURNING native_turn_publication_debt.frame_id
 ) SELECT
  (SELECT coalesce(jsonb_agg(jsonb_build_object('message',jsonb_build_object('id',m.id,'sessionId',s,'role',m.role,'content',m.content,
   'sequenceNum',m.sequence_num,'createdAt',m.created_at,'replyToText',NULL,'topicLabel',NULL,'topicConfidence',NULL,
   'channelMessageId',m.channel_message_id,'senderUserId',m.sender_user_id,'senderAssistantId',m.sender_assistant_id,'attachments',m.attachments),
   'source',t_scope||jsonb_build_object('resourceKind','session_message','resourceId',m.id,'version','1')) ORDER BY m.sequence_num),'[]') FROM t_written m),
  (SELECT jsonb_build_object('source',a_scope||jsonb_build_object('resourceKind','session_context_revision','resourceId',a_id,'version','1'),
   'createdAt',a.created_at,'userId',session_row.user_id,'assistantId',session_row.assistant_id) FROM a_annotation a)
 INTO results,annotation_result FROM(SELECT count(*) FROM debt) ready;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN CASE WHEN envelope THEN jsonb_build_object('messages',results,'annotation',annotation_result) ELSE results END;
EXCEPTION WHEN SQLSTATE 'PNT02' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
END $function$;
