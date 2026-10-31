BEGIN;
-- [COMP:api/application-persistence] Share current field evaluation within each
-- preparation; retain independent before/after preparations and original fallback.
DO $install$
DECLARE actual pg_proc;pins text;trusted text;original text;definition text;updated text;guard_pin text;acl record;fn regprocedure;
BEGIN
-- Declare pins text, trusted text, actual pg_proc in the caller's installer block.
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN('application_native_covered_queue_current()'::regprocedure,'application_native_root_cover(uuid,jsonb)'::regprocedure,'read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_covered_session_frame(uuid,text[],uuid[],text[])'::regprocedure,'validate_native_covered_field_dependency_work(uuid,uuid,bigint)'::regprocedure,'read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,'application_native_file_capture_helpers_current()'::regprocedure,'application_native_worklist_helpers_current()'::regprocedure,'native_worklist_edges(uuid,jsonb)'::regprocedure,'native_worklist_context(uuid,jsonb)'::regprocedure,'application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure,'read_application_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,'read_external_source_dependencies(uuid,text[],uuid[],text[])'::regprocedure,'application_empty_query_helpers_current()'::regprocedure,'application_memory_statement_helpers_current()'::regprocedure);
 trusted:='BEGIN
 IF (SELECT count(*)=17 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 RETURN application_native_worklist_helpers_current();
 END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_covered_evidence_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Covered evidence prerequisite guard changed';END IF;
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Covered evidence prerequisite dependencies changed';END IF;

 SELECT * INTO actual FROM pg_proc WHERE oid='prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM 'eca5aa0cbf5783306eeef2d5450bdcfee13a4d8aa3e71395b1c6684f50669719'
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.session_messages'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","producer","sources","target"],"proargtypes":["2950","2950","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
  WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native transcript preparation prerequisite changed';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('prepare_native_session_message_covered','application_native_transcript_prepare_helpers_current')) THEN
  RAISE EXCEPTION 'Native transcript preparation helper already exists';END IF;
 original:=actual.prosrc;definition:=pg_get_functiondef(actual.oid);
 EXECUTE $definition$CREATE FUNCTION public.prepare_native_session_message_covered(w uuid,s uuid,producer text,sources jsonb,target jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;node jsonb;current_source jsonb;
 expanded jsonb:=sources;retained jsonb:='[]';dependency record;root_kinds text[];root_ids uuid[];root_versions text[];
 floor_tier text;teams text[];projects uuid[];memo jsonb:='{}';evaluated jsonb;stored session_messages;derivation uuid;source_scope jsonb;
 proof jsonb;proof_fields jsonb;discovery_cover jsonb;projection jsonb;label jsonb;
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
   OR node->>'resourceKind' NOT IN('application_field','external_source','crm_event') AND scope_source_table(node->>'resourceKind') IS NULL THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 -- Discover immutable obligations before D1 can drop their native carrier.
 -- This metadata confers no authority; every collected source is admitted below.
 SELECT array_agg(value->>'resourceKind'),array_agg((value->>'resourceId')::uuid),array_agg(value->>'version')
  INTO root_kinds,root_ids,root_versions FROM jsonb_array_elements(sources);
 IF cardinality(root_ids)>100 THEN
  discovery_cover:=application_native_root_cover(w,(SELECT jsonb_agg(jsonb_build_object('kind',k,'id',i,'version',v)) FROM unnest(root_kinds,root_ids,root_versions) roots(k,i,v)));
  IF discovery_cover IS NULL THEN RETURN NULL;END IF;
  root_kinds:=ARRAY(SELECT r->>'kind' FROM jsonb_array_elements(discovery_cover->'roots') r);
  root_ids:=ARRAY(SELECT (r->>'id')::uuid FROM jsonb_array_elements(discovery_cover->'roots') r);
  root_versions:=ARRAY(SELECT r->>'version' FROM jsonb_array_elements(discovery_cover->'roots') r);
 END IF;
 FOR dependency IN
  SELECT fields.node_version,fields.source FROM jsonb_array_elements(sources) original(value)
  CROSS JOIN LATERAL (
   SELECT d.node_version,d.source FROM read_native_session_field_dependencies(w,ARRAY[original.value->>'resourceKind'],
    ARRAY[(original.value->>'resourceId')::uuid],ARRAY[original.value->>'version']) d
   WHERE original.value->>'resourceKind'='application_field' AND EXISTS(SELECT 1 FROM public.application_field_resources f
     WHERE f.workspace_id=w AND f.id=(original.value->>'resourceId')::uuid
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
   UNION ALL SELECT d.node_version,d.source FROM read_application_field_dependencies(w,ARRAY[original.value->>'resourceKind'],
    ARRAY[(original.value->>'resourceId')::uuid],ARRAY[original.value->>'version']) d
   WHERE NOT (original.value->>'resourceKind'='application_field' AND EXISTS(SELECT 1 FROM public.application_field_resources f
     WHERE f.workspace_id=w AND f.id=(original.value->>'resourceId')::uuid
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
  ) fields
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
 -- Fresh proof for this preparation only. Native lifecycle readers below
 -- remain unchanged; only immutable native field evaluation is shared.
 SELECT array_agg(value->>'resourceKind'),array_agg((value->>'resourceId')::uuid),array_agg(value->>'version')
 INTO root_kinds,root_ids,root_versions FROM jsonb_array_elements(expanded);
 proof:=read_native_covered_session_frame(w,root_kinds,root_ids,root_versions);
 IF proof->>'admitted' IS DISTINCT FROM 'true' OR discovery_cover IS NOT NULL AND proof->'lineage' IS DISTINCT FROM discovery_cover->'lineage' THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'current') item WHERE item->>'resourceKind'='application_field'
  GROUP BY item->>'resourceId' HAVING count(DISTINCT item)>1) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_object_agg(item->>'resourceId',item),'{}') INTO proof_fields
 FROM jsonb_array_elements(proof->'current') item WHERE item->>'resourceKind'='application_field';
 floor_tier:=CASE WHEN sensitivity_rank(target->>'sensitivity')>sensitivity_rank(parent->>'sensitivity') THEN target->>'sensitivity' ELSE parent->>'sensitivity' END;
 teams:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((parent->'compartments')||(target->'compartments')) value ORDER BY value);
 projects:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text((parent->'projectIds')||(target->'projectIds')) value ORDER BY value::uuid);
 FOR node IN SELECT value FROM jsonb_array_elements(expanded) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR node->>'userId' IS NOT NULL AND node->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF node->>'resourceKind'='application_field' THEN
   current_source:=(proof_fields->(node->>'resourceId'))||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
  ELSIF node->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(node->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(node->>'resourceId')::uuid,node->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,node->>'resourceKind',(node->>'resourceId')::uuid);END IF;
  -- Original immutable obligations never use native D1 disappearance semantics.
  IF node->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event')
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
  IF node->>'resourceKind'='application_field'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) original WHERE
    (original->>'resourceKind',original->>'resourceId',original->>'version')=(node->>'resourceKind',node->>'resourceId',node->>'version'))
   AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(node->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
   projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(node->>'resourceId')::uuid],ARRAY[node->>'version']);
   IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
    OR projection->'root' IS DISTINCT FROM (node-ARRAY['held','validTo','retractedAt'])
    OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
    IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE
     OR label->>'userId' IS NOT NULL AND label->>'userId' IS DISTINCT FROM target->>'userId'
      AND (target->>'userId' IS NOT NULL OR label->>'userId' IS DISTINCT FROM actor::text) THEN
     RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
    IF sensitivity_rank(label->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=label->>'sensitivity';END IF;
    teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(label->'compartments'))) item ORDER BY item);
    projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(label->'projectIds')::uuid)) item ORDER BY item);
   END LOOP;
   -- Metadata is not admission. Repeat the exact current H read after discovery.
   current_source:=read_admitted_application_field_snapshot(w,(node->>'resourceId')::uuid,node->>'version');
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
    OR (current_source-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM (node-ARRAY['held','validTo','retractedAt']) THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
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
  WHERE obligation.value->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) kept(value) WHERE
   (kept.value->>'resourceKind',kept.value->>'resourceId',kept.value->>'version')=
   (obligation.value->>'resourceKind',obligation.value->>'resourceId',obligation.value->>'version'))) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects);
 RETURN jsonb_build_object('scope',source_scope,'retained',retained);
END $body$;$definition$;
 EXECUTE 'CREATE FUNCTION public.application_native_transcript_prepare_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$BEGIN RETURN false;END$body$';
 -- Normalize all inherited grants, not only PUBLIC and the application role.
 FOREACH fn IN ARRAY ARRAY['prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)'::regprocedure,'application_native_transcript_prepare_helpers_current()'::regprocedure] LOOP
  FOR acl IN SELECT DISTINCT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=fn AND a.grantee<>p.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',fn,CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl.grantee)) END);
  END LOOP;
 END LOOP;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN('prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)'::regprocedure,
  'read_native_covered_session_frame(uuid,text[],uuid[],text[])'::regprocedure,'application_native_covered_evidence_helpers_current()'::regprocedure);
 trusted:='BEGIN
 IF (SELECT count(*)=3 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 RETURN application_native_covered_evidence_helpers_current();
 END';
 EXECUTE format('CREATE OR REPLACE FUNCTION public.application_native_transcript_prepare_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',trusted);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_pin FROM pg_proc p WHERE oid='application_native_transcript_prepare_helpers_current()'::regprocedure;
 updated:=replace(original,'BEGIN','DECLARE covered_preparation jsonb;
BEGIN
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'') FROM pg_proc p WHERE oid=''application_native_transcript_prepare_helpers_current()''::regprocedure)='||quote_literal(guard_pin)||' THEN
  IF application_native_transcript_prepare_helpers_current() IS TRUE THEN
   covered_preparation:=prepare_native_session_message_covered(w,s,producer,sources,target);
   IF covered_preparation IS NOT NULL AND (SELECT encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'') FROM pg_proc p WHERE oid=''application_native_transcript_prepare_helpers_current()''::regprocedure)='||quote_literal(guard_pin)||' THEN
    IF application_native_transcript_prepare_helpers_current() IS TRUE THEN RETURN covered_preparation;END IF;
   END IF;
  END IF;
 END IF;
 -- Unsupported or drifted optional work falls through to the inline original.
');
 IF length(original)-length(replace(original,'BEGIN',''))<>length('BEGIN') THEN RAISE EXCEPTION 'Native transcript preparation body shape changed';END IF;
 -- The original declaration block already starts DECLARE; append its variable
 -- declaration before BEGIN instead of introducing a nested declaration block.
 updated:=replace(updated,'DECLARE covered_preparation jsonb;',' covered_preparation jsonb;');
 EXECUTE replace(definition,original,updated);
END $install$;
COMMIT;
