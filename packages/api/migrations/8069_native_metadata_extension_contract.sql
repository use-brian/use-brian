BEGIN;
-- [COMP:api/application-persistence] Preserve the R2 SQL extension surface and canonical schema resolution.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure) IS DISTINCT FROM '77840ec5461f2255f9cd6ece5703c2321349c06280636d73a566fcfc4d7336f4'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.session_context_parent_snapshot(uuid,uuid)'::regprocedure) IS DISTINCT FROM '26698fc05654677fcbb7779412399c7d0005f9161709b34c014977e893102ae9' THEN
  RAISE EXCEPTION 'Canonical native metadata compatibility prerequisite changed';END IF;
END $$;
ALTER FUNCTION session_context_parent_snapshot(uuid,uuid) SET search_path=pg_catalog,public,pg_temp;

CREATE OR REPLACE FUNCTION application_scope_source_edges(w uuid,k text,i uuid,v text)
RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i
 UNION
 SELECT k,prior_id,v FROM unnest(CASE WHEN scope_source_table(k) IS NOT NULL
  THEN ARRAY(SELECT resource_id FROM scope_source_ancestors(w,k,i)) ELSE '{}'::uuid[] END) prior_id WHERE prior_id<>i
 UNION
 SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observations o
  WHERE k='application_field' AND o.workspace_id=w AND o.resource_id=i AND o.version=v
 UNION
 SELECT s.source_kind,s.source_id,s.source_version FROM application_field_observation_sources s
  WHERE k='application_field' AND s.workspace_id=w AND s.resource_id=i AND s.version=v
 UNION
 SELECT 'workspace_file',wf.id,wf.scope_version::text FROM file_segments fs
  JOIN workspace_files wf ON wf.id=fs.file_id AND wf.workspace_id=fs.workspace_id
  WHERE k='file_segment' AND fs.workspace_id=w AND fs.id=i
 UNION
 SELECT observed.value->>'resourceKind',(observed.value->>'resourceId')::uuid,observed.value->>'version'
  FROM jsonb_array_elements(CASE WHEN k='workflow_run' THEN read_workflow_derivation_inputs(w,i) ELSE '[]'::jsonb END) input
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(input#>'{evidence,sources}','[]'::jsonb)
   ||CASE WHEN jsonb_typeof(input->'blueprintSource')='object' THEN jsonb_build_array(input->'blueprintSource') ELSE '[]'::jsonb END) observed(value)
$$;
REVOKE ALL ON FUNCTION application_scope_source_edges(uuid,text,uuid,text) FROM PUBLIC;
-- Keep the reviewed native leaf transport; unknown extensions still take the full walk.


DO $migration$
DECLARE kernel record;routine record;definition text;values_sql text:='';semantic_hash text;old_values text;
BEGIN
 FOR kernel IN SELECT * FROM (VALUES
  ('public.application_scope_source_edges(uuid,text,uuid,text)','20d8c359a6b77c9c96aed3be9e31719e60868fb55e34aaedc2714494e6a8e974'),
  ('public.scope_source_ancestors(uuid,text,uuid)','d8e33fb3a66e4318ed159e288c797b6d55759481e1339d4e53c372cb6907e0e8'),
  ('public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8'),
  ('public.scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c'),
  ('public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)','401b62c0bf792041938e92d7ea4207f4a3f7bb9f070bfb6a4bea3aa0ee5cb957'),
  ('public.scope_source_table(text)','50b1e162e95c2cb9e01300d2ed70041cf89350004e11476352463eeba1e9d3d6'),
  ('public.scope_source_table_before_persistent_context(text)','77ae7215cf985148bc013cd5afd14cac03776580e347bf548c67b6d1ca7f40da'),
  ('public.scope_source_table_before_media(text)','93ff1be795bfbee59a38c43da3425018072c18007fe39e99ecd4d7e8731eba15')
 ) reviewed(signature,body_sha256) LOOP
  SELECT p.* INTO routine FROM pg_proc p WHERE p.oid=to_regprocedure(kernel.signature);
  IF NOT FOUND OR encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM kernel.body_sha256 THEN
   RAISE EXCEPTION 'Canonical persistent context kernel changed: %',kernel.signature;END IF;
  semantic_hash:=application_field_digest(jsonb_build_object('name',routine.proname,'namespace',routine.pronamespace,'body',routine.prosrc,
   'config',routine.proconfig,'language',routine.prolang,'securityDefiner',routine.prosecdef,'volatility',routine.provolatile,'strict',routine.proisstrict,'parallel',routine.proparallel));
  values_sql:=values_sql||CASE WHEN values_sql='' THEN '' ELSE ',' END||format('(%s::oid,%L::text)',routine.oid,semantic_hash);
 END LOOP;
 SELECT pg_get_functiondef('application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure) INTO definition;
 SELECT substring(definition FROM 'FROM [(]VALUES ([^;]+)[)] pin[(]function_oid,fingerprint[)]') INTO old_values;
 IF old_values IS NULL OR position('count(*)=8 AND coalesce(bool_and' IN definition)=0
  OR position('R2 canonical entity leaf transport' IN definition)=0 THEN RAISE EXCEPTION 'Canonical native leaf shortcut changed';END IF;
 definition:=replace(definition,'FROM (VALUES '||old_values||') pin(function_oid,fingerprint)', 'FROM (VALUES '||values_sql||') pin(function_oid,fingerprint)');
 EXECUTE definition;
END $migration$;

-- The closed native memory family has exactly the same leaf proof as Entity:
-- no canonical derivation, no predecessor and the original reviewed helpers.
DO $memory_leaf$
DECLARE definition text;before text;after text;
BEGIN
 SELECT pg_get_functiondef('public.application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure) INTO definition;
 before:=$old$  AND kinds[1]='entity'
  AND NOT EXISTS(SELECT 1 FROM public.scope_derivations d
   WHERE d.workspace_id=w AND d.resource_kind='entity' AND d.resource_id=ids[1])
  AND NOT EXISTS(SELECT 1 FROM public.entities e
   WHERE e.workspace_id=w AND e.superseded_by=ids[1])$old$;
 after:=$new$  AND kinds[1] IN('entity','memory')
  AND NOT EXISTS(SELECT 1 FROM public.scope_derivations d
   WHERE d.workspace_id=w AND d.resource_kind=kinds[1] AND d.resource_id=ids[1])
  AND (kinds[1]='entity' AND NOT EXISTS(SELECT 1 FROM public.entities e
    WHERE e.workspace_id=w AND e.superseded_by=ids[1])
   OR kinds[1]='memory' AND NOT EXISTS(SELECT 1 FROM public.memories m
    WHERE m.workspace_id=w AND m.superseded_by=ids[1]))$new$;
 IF length(definition)-length(replace(definition,before,''))<>length(before)
  OR position('R2 canonical entity leaf transport' IN definition)=0
  OR position('count(*)=8 AND coalesce(bool_and' IN definition)=0 THEN
  RAISE EXCEPTION 'Reviewed native leaf transport changed';END IF;
 EXECUTE replace(definition,before,after);
END $memory_leaf$;

-- Return the current root snapshot from its canonical evaluation, only within
-- this read operation. No snapshot is stored in a memo or reused across calls.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_session_eval_scope(uuid,text,uuid,text,jsonb)'::regprocedure) IS DISTINCT FROM '96e58ebe7bcdfd022d16d1533cbfaf72076c9694141cd754c1cf18e6ec7ba13f' THEN RAISE EXCEPTION 'Native scope evaluator changed';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_evidence(uuid,text[],uuid[],text[])'::regprocedure) IS DISTINCT FROM '5492b297a00b3bcf968f3411d0887131fa849aa0d266ba4422d6c9966280385f' THEN RAISE EXCEPTION 'Closed native evidence reader changed: read_native_session_evidence';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure) IS DISTINCT FROM 'c39498402ffcb99b5a9a625af79fa7f665a179353cad1c5382a5cbae8bbb8d55' THEN RAISE EXCEPTION 'Closed native evidence reader changed: read_native_attended_memory_evidence';END IF;
END $$;
CREATE FUNCTION application_session_eval_scope_current(w uuid,k text,i uuid,v text,memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text:='native:'||k||':'||i||':'||v;nodes jsonb;node jsonb;refs jsonb:='[]';current_source jsonb;result jsonb;dependency record;policy jsonb;mask jsonb;type_key text;root_current jsonb;
BEGIN
 IF memo ? key THEN
  IF memo#>>ARRAY[key,'busy']='true' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  result:=jsonb_build_object('value',memo#>ARRAY[key,'value']='true'::jsonb AND application_session_eval_sources_current(w,memo#>ARRAY[key,'external']),'memo',memo);
  IF result->>'value'='true' THEN
   -- A worklist hit still performs its current canonical native-root read.
   RETURN result||jsonb_build_object('current',read_admitted_native_scope_snapshot(w,k,i));
  END IF;
  RETURN result;
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(memo))>=4096 THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 memo:=memo||jsonb_build_object(key,jsonb_build_object('busy',true));
 SELECT coalesce(jsonb_agg(to_jsonb(n)),'[]') INTO nodes FROM application_scope_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v]) n;
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  IF node->>'kind'='application_field' THEN
   result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=result->'memo';current_source:=result->'value';
   refs:=refs||coalesce(memo#>ARRAY['field:'||(node->>'id')||':'||(node->>'version'),'external'],'[]'::jsonb);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  ELSIF node->>'kind'='external_source' THEN
   refs:=refs||jsonb_build_array(jsonb_build_object('id',node->'id','version',node->'version'));
   current_source:=external_source_snapshot(w,(node->>'id')::uuid);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version' THEN
    RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  ELSIF scope_source_table(node->>'kind') IS NOT NULL THEN
   IF node->>'kind'='session_context_revision' AND read_entity_derivation_source(w,node->>'kind',(node->>'id')::uuid) IS NULL THEN
    RETURN jsonb_build_object('value',false,'memo',memo);END IF;
   current_source:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
   IF node->>'kind' IN('crm_event','session_context_revision') AND current_source IS NULL
    OR current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
   IF node->>'kind'=k AND (node->>'id')::uuid=i THEN root_current:=current_source;END IF;
  END IF;
 END LOOP;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 END LOOP;
 -- An explicit raw entity source consumes the complete current field mask,
 -- unlike the selected native anchors of a field projection.
 FOR dependency IN SELECT DISTINCT edge.source_id FROM scope_derivation_sources edge JOIN scope_derivations d
  ON d.workspace_id=edge.workspace_id AND d.id=edge.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
  WHERE d.workspace_id=w AND edge.source_kind='entity' LOOP
  SELECT kind INTO type_key FROM entities WHERE workspace_id=w AND id=dependency.source_id;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN CONTINUE;END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id);
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR mask->>'held' IS DISTINCT FROM 'false'
    OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO refs FROM (SELECT DISTINCT value FROM jsonb_array_elements(refs)) unique_refs;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
  WHERE n->>'kind'='application_field' AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN
  memo:=memo-key;
 ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',true,'external',refs)); END IF;RETURN jsonb_build_object('value',true,'memo',memo,'current',root_current);
END $$;
REVOKE ALL ON FUNCTION application_session_eval_scope_current(uuid,text,uuid,text,jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION read_native_session_evidence(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS jsonb
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
  result:=application_session_eval_scope_current(w,node->>'kind',(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);
  IF result->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=nullif(result->'current','null'::jsonb);
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
CREATE OR REPLACE FUNCTION read_native_attended_memory_evidence(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS jsonb
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
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory')) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR field.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory'))
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
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision','memory') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  result:=application_session_eval_scope_current(w,node->>'kind',(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);
  IF result->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=nullif(result->'current','null'::jsonb);
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
REVOKE ALL ON FUNCTION read_native_attended_memory_evidence(uuid,text[],uuid[],text[]) FROM PUBLIC;
COMMIT;
