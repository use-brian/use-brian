BEGIN;
-- [COMP:api/application-persistence] One atomic native transcript effect.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)'::regprocedure)
  IS DISTINCT FROM 'e2317bcabfb26e6b36e9ddbb00bfeea0bc057c16f71939f695c01d088b6bd997' THEN RAISE EXCEPTION 'Canonical native transcript writer changed';END IF;
END $$;
CREATE FUNCTION prepare_native_session_message_batch(w uuid,s uuid,producer text,sources jsonb,target jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;node jsonb;current_source jsonb;
 expanded jsonb:=sources;retained jsonb:='[]';dependency record;root_kinds text[];root_ids uuid[];root_versions text[];
 floor_tier text;teams text[];projects uuid[];memo jsonb:='{}';evaluated jsonb;stored session_messages;derivation uuid;source_scope jsonb;
BEGIN
 parent:=lock_native_session_context_publication(w,s);
 IF jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR entity_derivation_envelope_valid(target) IS NOT TRUE OR target->>'workspaceId' IS DISTINCT FROM w::text
  OR target->>'assistantId' IS NOT NULL OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId'
 THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR jsonb_typeof(node->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(node->'resourceId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(node->'version') IS DISTINCT FROM 'string' OR length(btrim(node->>'version')) NOT BETWEEN 1 AND 256
   OR node->>'resourceKind' NOT IN('application_field','external_source') AND scope_source_table(node->>'resourceKind') IS NULL THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 -- Discover immutable obligations before D1 can drop their native carrier.
 -- This metadata confers no authority; every collected source is admitted below.
 SELECT array_agg(value->>'resourceKind'),array_agg((value->>'resourceId')::uuid),array_agg(value->>'version')
  INTO root_kinds,root_ids,root_versions FROM jsonb_array_elements(sources);
 FOR dependency IN
  SELECT node_version,source FROM read_application_field_dependencies(w,root_kinds,root_ids,root_versions)
  UNION ALL SELECT node_version,source FROM read_external_source_dependencies(w,root_kinds,root_ids,root_versions)
  UNION ALL SELECT n.version,read_scope_source(w,n.kind,n.id) FROM application_scope_lineage(w,root_kinds,root_ids,root_versions) n WHERE n.kind='session_context_revision'
 LOOP
  node:=dependency.source;
  IF node IS NULL OR node->>'held'='true' OR node->>'version' IS DISTINCT FROM dependency.node_version
   OR entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  node:=jsonb_build_object('workspaceId',node->'workspaceId','userId',node->'userId','assistantId',node->'assistantId',
   'sensitivity',node->'sensitivity','compartments',node->'compartments','projectIds',node->'projectIds',
   'resourceKind',node->'resourceKind','resourceId',node->'resourceId','version',node->'version');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')
   AND (original->>'version' IS DISTINCT FROM node->>'version' OR (original-ARRAY['held','validTo','retractedAt','causalEntityId']) IS DISTINCT FROM node)) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')) THEN
   expanded:=expanded||jsonb_build_array(node);END IF;
  IF jsonb_array_length(expanded)>4096 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (candidate.value->>'resourceKind',candidate.value->>'resourceId')) FROM jsonb_array_elements(expanded) candidate(value))<>jsonb_array_length(expanded) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 floor_tier:=CASE WHEN sensitivity_rank(target->>'sensitivity')>sensitivity_rank(parent->>'sensitivity') THEN target->>'sensitivity' ELSE parent->>'sensitivity' END;
 teams:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((parent->'compartments')||(target->'compartments')) value ORDER BY value);
 projects:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text((parent->'projectIds')||(target->'projectIds')) value ORDER BY value::uuid);
 FOR node IN SELECT value FROM jsonb_array_elements(expanded) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR node->>'userId' IS NOT NULL AND node->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF node->>'resourceKind'='application_field' THEN
   evaluated:=application_session_eval_field(w,(node->>'resourceId')::uuid,node->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
  ELSIF node->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(node->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(node->>'resourceId')::uuid,node->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,node->>'resourceKind',(node->>'resourceId')::uuid);END IF;
  -- Original immutable obligations never use native D1 disappearance semantics.
  IF node->>'resourceKind' IN('application_field','external_source','session_context_revision')
   AND (current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version'
    OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
    OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
      IS DISTINCT FROM (node->'workspaceId',node->'userId',node->'assistantId',node->'sensitivity')
    OR NOT (current_source->'compartments')@>(node->'compartments') OR NOT (node->'compartments')@>(current_source->'compartments')
    OR NOT (current_source->'projectIds')@>(node->'projectIds') OR NOT (node->'projectIds')@>(current_source->'projectIds')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node->>'resourceKind'='crm_event' AND (current_source IS NULL OR current_source->>'version' IS DISTINCT FROM node->>'version'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) e WHERE e->>'resourceKind'='entity' AND e->>'resourceId'=current_source->>'causalEntityId')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF sensitivity_rank(node->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=node->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(node->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(node->'projectIds')::uuid)) value ORDER BY value);
  IF current_source IS NOT NULL AND current_source->>'validTo' IS NULL AND current_source->>'retractedAt' IS NULL THEN
   IF sensitivity_rank(current_source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=current_source->>'sensitivity';END IF;
   teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(current_source->'compartments'))) value ORDER BY value);
   projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(current_source->'projectIds')::uuid)) value ORDER BY value);
   IF current_source->>'version'=node->>'version' AND (current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS NOT DISTINCT FROM (node->'userId',node->'assistantId',node->'sensitivity') AND current_source->'compartments'=node->'compartments'
    AND current_source->'projectIds'=node->'projectIds' THEN retained:=retained||jsonb_build_array(node);END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) obligation(value)
  WHERE obligation.value->>'resourceKind' IN('application_field','external_source','session_context_revision')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) kept(value) WHERE
   (kept.value->>'resourceKind',kept.value->>'resourceId',kept.value->>'version')=
   (obligation.value->>'resourceKind',obligation.value->>'resourceId',obligation.value->>'version'))) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects);
 RETURN jsonb_build_object('scope',source_scope,'retained',retained);
END $$;
REVOKE ALL ON FUNCTION prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION publish_native_session_message_batch(w uuid,s uuid,payloads jsonb,producer text,sources jsonb,target jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;payload jsonb;node jsonb;
 prepared jsonb;fresh jsonb;retained jsonb;source_scope jsonb;stored session_messages;derivation uuid;
 results jsonb:='[]';floor_tier text;teams text[];projects uuid[];
BEGIN
 IF jsonb_typeof(payloads) IS DISTINCT FROM 'array' OR jsonb_array_length(payloads) NOT BETWEEN 1 AND 512 THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 parent:=lock_native_session_context_publication(w,s);
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
 prepared:=prepare_native_session_message_batch(w,s,producer,sources,target);
 retained:=prepared->'retained';source_scope:=prepared->'scope';floor_tier:=source_scope->>'sensitivity';
 teams:=ARRAY(SELECT jsonb_array_elements_text(source_scope->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(source_scope->'projectIds')::uuid);
 FOR payload IN SELECT value FROM jsonb_array_elements(payloads) LOOP
 FOR node IN SELECT value FROM jsonb_array_elements(payload->'attachments') LOOP
  IF jsonb_typeof(node) IS DISTINCT FROM 'object' OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) input WHERE input->>'resourceKind'='workspace_file' AND input->>'resourceId'=node->>'fileId') THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 END LOOP;
 -- One logical SQL batch writes all rows with complete immutable ancestry.
 FOR payload IN SELECT value FROM jsonb_array_elements(payloads) LOOP
 INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,sender_user_id,sender_assistant_id,attachments,
  workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
  SELECT s,payload->>'role',payload->'content',coalesce(max(sequence_num),0)+1,payload->>'channelMessageId',
   (payload->>'senderUserId')::uuid,(payload->>'senderAssistantId')::uuid,payload->'attachments',w,(target->>'userId')::uuid,NULL,floor_tier,teams,projects,1,false
  FROM session_messages WHERE session_id=s RETURNING * INTO stored;
 IF jsonb_array_length(retained)>0 THEN
  INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
   SELECT w,'session_message',stored.id,'1',producer,(target->>'userId')::uuid,NULL,floor_tier,teams,projects,revision FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
   SELECT w,derivation,value->>'resourceKind',(value->>'resourceId')::uuid,value->>'version' FROM jsonb_array_elements(retained) ORDER BY value->>'resourceKind',value->>'resourceId';
 END IF;
 results:=results||jsonb_build_array(jsonb_build_object('message',jsonb_build_object('id',stored.id,'sessionId',s,'role',stored.role,'content',stored.content,
  'sequenceNum',stored.sequence_num,'createdAt',stored.created_at,'replyToText',NULL,'topicLabel',NULL,'topicConfidence',NULL,
  'channelMessageId',stored.channel_message_id,'senderUserId',stored.sender_user_id,'senderAssistantId',stored.sender_assistant_id,'attachments',stored.attachments),
  'source',source_scope||jsonb_build_object('resourceKind','session_message','resourceId',stored.id,'version','1')));
 END LOOP;
 -- No earlier worklist can qualify a later boundary. Re-evaluate the original
 -- source/field/parent checks in this same operation after its final row.
 fresh:=prepare_native_session_message_batch(w,s,producer,sources,target);
 IF fresh IS DISTINCT FROM prepared THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN results;
END $$;
REVOKE ALL ON FUNCTION publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb) TO app_user;
 END IF;
END $$;
COMMIT;
