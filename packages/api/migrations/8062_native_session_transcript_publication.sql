BEGIN;
-- Closed native transcript publication; no alteration of R2 field writers,
-- grants to raw lineage tables, or owner/session impersonation.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.lock_native_session_context_publication(uuid,uuid)')
  AND prosecdef AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='66919110c9b401e0e3e52686adc5a1e182bfdcff7a8d132aab237199c8b22a9a') THEN
  RAISE EXCEPTION 'Native transcript prerequisite changed: publication lock';END IF;
END $$;

-- Metadata only, under the actual native parent admission and row lock.
CREATE FUNCTION read_native_session_query_floor(w uuid,s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent jsonb;
BEGIN
 parent:=application_session_query_parent(w,s);
 RETURN parent->'scope';
END $$;
REVOKE ALL ON FUNCTION read_native_session_query_floor(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_session_query_floor(uuid,uuid) TO app_user;END IF;
END $$;

CREATE FUNCTION publish_native_session_message(w uuid,s uuid,payload jsonb,producer text,sources jsonb,target jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;node jsonb;current_source jsonb;
 expanded jsonb:=sources;retained jsonb:='[]';dependency record;root_kinds text[];root_ids uuid[];root_versions text[];
 floor_tier text;teams text[];projects uuid[];memo jsonb:='{}';evaluated jsonb;stored session_messages;derivation uuid;source_scope jsonb;
BEGIN
 parent:=lock_native_session_context_publication(w,s);
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
 FOR node IN SELECT value FROM jsonb_array_elements(payload->'attachments') LOOP
  IF jsonb_typeof(node) IS DISTINCT FROM 'object' OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) input WHERE input->>'resourceKind'='workspace_file' AND input->>'resourceId'=node->>'fileId') THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects);
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
 RETURN jsonb_build_object('message',jsonb_build_object('id',stored.id,'sessionId',s,'role',stored.role,'content',stored.content,
  'sequenceNum',stored.sequence_num,'createdAt',stored.created_at,'replyToText',NULL,'topicLabel',NULL,'topicConfidence',NULL,
  'channelMessageId',stored.channel_message_id,'senderUserId',stored.sender_user_id,'senderAssistantId',stored.sender_assistant_id,'attachments',stored.attachments),
  'source',source_scope||jsonb_build_object('resourceKind','session_message','resourceId',stored.id,'version','1'));
END $$;
REVOKE ALL ON FUNCTION publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb) TO app_user;END IF;
END $$;
-- An exact call-local empty reference list avoids only a duplicate metadata walk.
-- Point/parent/payload checks run unchanged. No envelope result is reused.
DO $migration$
DECLARE definition text;before text;after text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)')
  AND prosecdef AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='919143d4471b55247824bca26885c9076b63708f8c216485fb676f3436bd9ba8') THEN
  RAISE EXCEPTION 'Native session metadata prerequisite changed: application_session_eval_envelope';END IF;
 SELECT pg_get_functiondef('public.application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)'::regprocedure) INTO definition;
 before:=$old$ FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[(state->>'sourceId')::uuid],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN jsonb_build_object('memo',memo);END IF;
  sources:=sources||jsonb_build_array(external.source);
 END LOOP;$old$;
 after:=$new$ IF memo#>>ARRAY['native:'||(state->>'sourceKind')||':'||(state->>'sourceId')||':'||(state->>'sourceVersion'),'value'] IS DISTINCT FROM 'true'
  OR memo#>ARRAY['native:'||(state->>'sourceKind')||':'||(state->>'sourceId')||':'||(state->>'sourceVersion'),'external'] IS DISTINCT FROM '[]'::jsonb THEN
 FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[(state->>'sourceId')::uuid],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN jsonb_build_object('memo',memo);END IF;
  sources:=sources||jsonb_build_array(external.source);
 END LOOP;
 END IF;$new$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native session external metadata walk changed';END IF;
 EXECUTE replace(definition,before,after);
END $migration$;

-- Owner-only discovery of the complete original query cohort. No values,
-- permission decisions, new source kind or app-callable selector/allow token.
CREATE FUNCTION read_native_session_query_cohort_sources(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item record;selector record;message record;specs jsonb:='[]';root jsonb;kind text;id uuid;attempts integer:=0;
 candidates jsonb;part record;has_external boolean:=false;
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR item IN SELECT DISTINCT q.type_key,q.domain FROM application_scope_lineage(w,kinds,ids,versions) node
  JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=node.id AND node.kind='application_field'
  JOIN application_field_observations observation ON observation.workspace_id=w AND observation.resource_id=resource.id AND observation.version=node.version
  JOIN application_query_domains q ON q.workspace_id=w AND q.id=resource.resource_id AND q.origin=resource.origin AND q.type_key=resource.type_key
  WHERE resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key IN('session_message','session_message_annotation')
   AND resource.selection='query_domain' LOOP
  IF item.domain->>'kind' IS DISTINCT FROM 'session_query_domain_v1' OR application_query_scope_valid(item.domain->'bounds') IS NOT TRUE
   OR jsonb_typeof(item.domain->'visibility') IS DISTINCT FROM 'object' OR jsonb_typeof(item.domain->'throughSequence') IS DISTINCT FROM 'number'
   OR (item.domain->>'throughSequence')::integer<0 OR item.domain->>'sessionId' IS NULL THEN
   RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
  specs:=specs||jsonb_build_array(jsonb_build_object('type',item.type_key,'sessionId',item.domain->'sessionId',
   'bounds',item.domain->'bounds','visibility',item.domain->'visibility','through',item.domain->'throughSequence'));
 END LOOP;
 -- A complete fresh physical-cohort superset can prove there are no
 -- independent-source references before expensive native scope snapshots.
 -- This grants no local rights and does not reuse an envelope or permission.
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',n.kind,'id',n.id,'version',n.version)),'[]') INTO candidates FROM (
  SELECT DISTINCT CASE WHEN spec.value->>'type'='session_message' THEN 'session_message' ELSE 'session_context_revision' END AS kind,
   CASE WHEN spec.value->>'type'='session_message' THEN m.id ELSE h.scope_revision_id END AS id,
   CASE WHEN spec.value->>'type'='session_message' THEN m.scope_version::text ELSE '1' END AS version
  FROM jsonb_array_elements(specs) spec(value)
  JOIN session_messages m ON m.workspace_id=w AND m.session_id=(spec.value->>'sessionId')::uuid AND m.sequence_num<=(spec.value->>'through')::integer
  LEFT JOIN session_message_annotation_heads h ON h.workspace_id=m.workspace_id AND h.session_id=m.session_id AND h.message_id=m.id
  WHERE spec.value->>'type'='session_message' OR h.scope_revision_id IS NOT NULL
  LIMIT 4097
 ) n;
 IF jsonb_array_length(candidates)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
 FOR part IN SELECT array_agg(node->>'kind') AS kinds,array_agg((node->>'id')::uuid) AS ids,array_agg(node->>'version') AS versions
  FROM jsonb_array_elements(candidates) WITH ORDINALITY candidate(node,ord) GROUP BY (ord-1)/100 LOOP
  IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,part.kinds,part.ids,part.versions)) THEN has_external:=true;EXIT;END IF;
 END LOOP;
 IF NOT has_external THEN RETURN;END IF;
 -- Equal scope/visibility prefixes have an exact union at their maximum
 -- sequence. Field values never participate in this metadata normalization.
 FOR selector IN SELECT value->>'type' AS type_key,(value->>'sessionId')::uuid AS session_id,
  value->'bounds' AS bounds,value->'visibility' AS visibility,max((value->>'through')::integer) AS through_sequence
  FROM jsonb_array_elements(specs) GROUP BY value->>'type',value->>'sessionId',value->'bounds',value->'visibility' LOOP
  FOR message IN SELECT m.id,m.scope_version,h.scope_revision_id FROM session_messages m
   LEFT JOIN session_message_annotation_heads h ON h.workspace_id=m.workspace_id AND h.session_id=m.session_id AND h.message_id=m.id
   WHERE m.workspace_id=w AND m.session_id=selector.session_id AND m.sequence_num<=selector.through_sequence ORDER BY m.sequence_num,m.id LOOP
   IF selector.type_key='session_message' THEN kind:='session_message';id:=message.id;
   ELSE kind:='session_context_revision';id:=message.scope_revision_id;IF id IS NULL THEN CONTINUE;END IF;END IF;
   root:=read_scope_source(w,kind,id);
   IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' THEN CONTINUE;END IF;
   IF application_query_scope_admits_point(selector.bounds,root) IS NOT TRUE
    OR root->>'userId' IS NOT NULL AND root->>'userId' IS DISTINCT FROM selector.visibility->>'userId'
    OR root->>'assistantId' IS NOT NULL AND selector.visibility->'assistants'<>'null'::jsonb
     AND NOT coalesce(selector.visibility->'assistants' ? (root->>'assistantId'),false) THEN CONTINUE;END IF;
   attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',root->'userId','assistantId',root->'assistantId',
    'sensitivity',root->'sensitivity','compartments',root->'compartments','projectIds',root->'projectIds',
    'resourceKind',kind,'resourceId',id,'version',root->'version');RETURN NEXT;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_session_query_cohort_sources(uuid,text[],uuid[],text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION read_native_session_query_cohort_sources(uuid,text[],uuid[],text[]) FROM app_user;END IF;
END $$;

-- Closed native session evidence batch. The invocation owns its private
-- worklist; no caller-provided memo, envelope or authorization result exists.
CREATE FUNCTION read_native_session_evidence(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- Every other profile/resource family delegates to the original validator.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message')) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR field.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_sources(w,kinds,ids,versions)) THEN RETURN NULL;END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 -- Read every original field under the current actor and original selector.
 -- Parent/payload/domain checks are inside the unchanged closed evaluator.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='application_field' ORDER BY value->>'id',value->>'version' LOOP
  SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
  result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  currents:=currents||jsonb_build_array(current_source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 -- Direct native/context roots and every persistent ancestor retain the same
 -- current native admission, D1 lifecycle and immutable high-water behavior.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  result:=application_session_eval_scope(w,node->>'kind',(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);
  IF result->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
  IF current_source IS NULL THEN
   IF node->>'kind'='session_context_revision' THEN RETURN jsonb_build_object('admitted',false);END IF;
   CONTINUE;
  END IF;
  IF current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
   'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
   'resourceKind',node->'kind','resourceId',node->'id','version',current_source->'version');
  currents:=currents||jsonb_build_array(current_source);
  IF node->>'kind'='session_context_revision' THEN
   IF current_source->>'version' IS DISTINCT FROM node->>'version' THEN RETURN jsonb_build_object('admitted',false);END IF;
   immutable:=immutable||jsonb_build_array(current_source);
  END IF;
 END LOOP;
 IF nodes IS DISTINCT FROM(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') FROM application_scope_lineage(w,kinds,ids,versions) n) THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_sources(w,kinds,ids,versions)) THEN RETURN jsonb_build_object('admitted',false);END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);
END $$;
REVOKE ALL ON FUNCTION read_native_session_evidence(uuid,text[],uuid[],text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_session_evidence(uuid,text[],uuid[],text[]) TO app_user;END IF;
END $$;

COMMIT;
