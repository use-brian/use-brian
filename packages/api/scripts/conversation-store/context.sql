-- [COMP:api/native-turn-frame] Annotation and title dispatch share canonical publication.
CREATE OR REPLACE FUNCTION public.publish_native_session_context_revision(w uuid, s uuid, k text, p uuid, i uuid, payload jsonb, producer text, sources jsonb, expected_revision uuid, expected_generation bigint, expected_cursor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE framed jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;target sessions;
 source jsonb;current_source jsonb;floor_tier text;teams text[];projects uuid[];previous uuid;derivation uuid;created timestamptz;memo jsonb:='{}';
BEGIN
 IF k IN('message_annotation','session_title') THEN
  framed:=publish_native_session_message_batch(w,s,jsonb_build_object('messages','[]'::jsonb,'annotation',jsonb_build_object(
   'kind',k,'parentId',p,'id',i,'content',payload,'producer',producer,'sources',sources,'expectedRevision',expected_revision,'expectedGeneration',expected_generation)),producer,sources,NULL);
  RETURN NULLIF(framed->'annotation','null'::jsonb);
 END IF;
 parent:=lock_native_session_context_publication(w,s);
 IF k NOT IN('session_state','episodic_memory','compact_summary') OR p IS NULL OR i IS NULL
  OR session_context_payload_shape(k,payload) IS NOT TRUE OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR (SELECT count(DISTINCT (node->>'resourceKind',node->>'resourceId')) FROM jsonb_array_elements(sources) node)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT target FROM sessions WHERE workspace_id=w AND id=s;
 IF expected_generation IS NOT NULL AND target.session_context_generation<>expected_generation THEN RETURN NULL;END IF;
 IF k='compact_summary' THEN
  IF p<>s OR target.compact_boundary_sequence IS DISTINCT FROM expected_cursor THEN RETURN NULL;END IF;
 ELSIF k='session_state' THEN
  SELECT scope_revision_id INTO previous FROM session_state WHERE id=p AND session_id=s;
  IF FOUND THEN IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
  ELSIF expected_revision IS NOT NULL OR expected_generation IS NULL THEN RETURN NULL;END IF;
 ELSE
  IF expected_revision IS NOT NULL OR EXISTS(SELECT 1 FROM episodic_memories WHERE id=p) THEN RETURN NULL;END IF;
 END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(guard_proc)::text,'UTF8')),'hex') FROM pg_proc guard_proc WHERE guard_proc.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 memo:=conversation_dag(w,(SELECT jsonb_agg(jsonb_build_object('kind',n->>'resourceKind','id',n->>'resourceId','version',n->>'version')) FROM jsonb_array_elements(sources) n),'[]');
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   current_source:=memo#>ARRAY['field:'||(source->>'resourceId')||':'||(source->>'version'),'value'];
  ELSIF source->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(source->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR current_source->>'version' IS DISTINCT FROM source->>'version'
   OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
   OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current_source->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current_source->'compartments')
   OR NOT (current_source->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current_source->'projectIds') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) item ORDER BY item);
  projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) item ORDER BY item);
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;

 INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  VALUES(i,w,s,k,p,(parent->>'userId')::uuid,NULL,floor_tier,teams,projects,encode(sha256(convert_to(payload::text,'UTF8')),'hex')) RETURNING created_at INTO created;
 INSERT INTO session_context_revision_contents(workspace_id,revision_id,content) VALUES(w,i,payload);
 IF k='session_state' THEN
  INSERT INTO session_state(id,session_id,user_id,assistant_id,key,status,summary,detail,source,scope_revision_id)
   VALUES(p,s,target.user_id,target.assistant_id,p::text,'open','',NULL,'tool',i)
   ON CONFLICT(id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id,updated_at=now();
 ELSIF k='episodic_memory' THEN
  INSERT INTO episodic_memories(id,user_id,assistant_id,session_id,topic_label,summary,message_span,scope_revision_id)
   VALUES(p,target.user_id,target.assistant_id,s,'','','{}',i);
 ELSE
  UPDATE sessions SET compact_summary=NULL,compact_scope_revision_id=i,compact_boundary_sequence=(payload->>'boundarySequence')::integer,
   compaction_count=compaction_count+1,last_compacted_at=now() WHERE workspace_id=w AND id=s;
 END IF;
 UPDATE sessions SET session_context_generation=session_context_generation+1 WHERE workspace_id=w AND id=s;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',i,'1',producer,(parent->>'userId')::uuid,NULL,floor_tier,teams,projects,revision FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,node->>'resourceKind',(node->>'resourceId')::uuid,node->>'version' FROM jsonb_array_elements(sources) node ORDER BY node->>'resourceKind',node->>'resourceId';
 IF (SELECT encode(sha256(convert_to(to_jsonb(guard_proc)::text,'UTF8')),'hex') FROM pg_proc guard_proc WHERE guard_proc.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('source',jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,'version','1',
  'userId',parent->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects),
  'createdAt',created,'userId',target.user_id,'assistantId',target.assistant_id);
END $function$
;
