BEGIN;
-- [COMP:api/application-persistence] Reuse field proof only within each existing
-- read-only validation pass. No mutating publication is retried as fallback.
DO $install$
DECLARE actual pg_proc;pins text;trusted text;body text;original text;definition text;updated text;guard_pin text;routine regprocedure;recipient record;
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

 SELECT * INTO actual FROM pg_proc WHERE oid='publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)'::regprocedure;
 IF encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM '7dc3e78f0668b20dc10de455c81537c1e015b84fad1521d7f3e9b27cf288a8e7'
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.session_messages'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_context_revision","prorows":0,"pronargs":11,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","k","p","i","payload","producer","sources","expected_revision","expected_generation","expected_cursor"],"proargtypes":["2950","2950","25","2950","2950","3802","25","3802","2950","20","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR (a.grantee<>actual.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user' AND oid=a.grantee)))
 THEN RAISE EXCEPTION 'Native context field prerequisite changed';END IF;
 original:=actual.prosrc;definition:=pg_get_functiondef(actual.oid);
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('read_native_context_field_currents','application_native_context_fields_current')) THEN RAISE EXCEPTION 'Native context field helper already exists';END IF;
 EXECUTE $helper$
 CREATE FUNCTION read_native_context_field_currents(w uuid,sources jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
 DECLARE kinds text[];ids uuid[];versions text[];proof jsonb;fields jsonb;
 BEGIN
 IF jsonb_typeof(sources) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 IF jsonb_array_length(sources) NOT BETWEEN 1 AND 4096 OR EXISTS(SELECT 1 FROM jsonb_array_elements(sources) n
 WHERE entity_derivation_envelope_valid(n) IS NOT TRUE OR n->>'workspaceId' IS DISTINCT FROM w::text
 OR (n->>'resourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS NOT TRUE
 OR jsonb_typeof(n->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'version') IS DISTINCT FROM 'string') THEN RETURN NULL;END IF;
 SELECT array_agg(n->>'resourceKind'),array_agg((n->>'resourceId')::uuid),array_agg(n->>'version') INTO kinds,ids,versions FROM jsonb_array_elements(sources) n;
 proof:=read_native_covered_session_frame(w,kinds,ids,versions);
 IF proof->>'admitted' IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'current') n WHERE n->>'resourceKind'='application_field'
 GROUP BY n->>'resourceId' HAVING count(DISTINCT n)>1) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_object_agg(n->>'resourceId',n),'{}') INTO fields FROM jsonb_array_elements(proof->'current') n WHERE n->>'resourceKind'='application_field';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(sources) n WHERE n->>'resourceKind'='application_field' AND NOT fields ? (n->>'resourceId')) THEN RETURN NULL;END IF;
 RETURN fields;
 END $body$;
 $helper$;
 EXECUTE 'CREATE FUNCTION application_native_context_fields_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$BEGIN RETURN false;END$body$';
 FOREACH routine IN ARRAY ARRAY['read_native_context_field_currents(uuid,jsonb)'::regprocedure,'application_native_context_fields_current()'::regprocedure] LOOP
 FOR recipient IN SELECT DISTINCT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=routine AND a.grantee<>p.proowner LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',routine,CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(recipient.grantee)) END);
 END LOOP;
 END LOOP;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid) INTO pins
 FROM pg_proc p WHERE oid IN('read_native_context_field_currents(uuid,jsonb)'::regprocedure,'read_native_covered_session_frame(uuid,text[],uuid[],text[])'::regprocedure,'application_native_covered_evidence_helpers_current()'::regprocedure);
 trusted:='BEGIN
 IF (SELECT count(*)=3 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
 FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 RETURN application_native_covered_evidence_helpers_current();
 END';
 EXECUTE format('CREATE OR REPLACE FUNCTION application_native_context_fields_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',trusted);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_pin FROM pg_proc p WHERE oid='application_native_context_fields_current()'::regprocedure;
 updated:=replace($updated$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;target sessions;
 source jsonb;current_source jsonb;floor_tier text;teams text[];projects uuid[];previous uuid;derivation uuid;created timestamptz;memo jsonb:='{}';field_currents jsonb;evaluated jsonb;projection jsonb;label jsonb;
BEGIN
 parent:=lock_native_session_context_publication(w,s);
 IF k NOT IN('session_state','episodic_memory','compact_summary','message_annotation','session_title') OR p IS NULL OR i IS NULL
  OR session_context_payload_shape(k,payload) IS NOT TRUE OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR (SELECT count(DISTINCT (node->>'resourceKind',node->>'resourceId')) FROM jsonb_array_elements(sources) node)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT target FROM sessions WHERE workspace_id=w AND id=s;
 IF expected_generation IS NOT NULL AND target.session_context_generation<>expected_generation THEN RETURN NULL;END IF;
 IF k='session_title' THEN
  IF p<>s OR (payload->>'manual')::boolean IS FALSE AND target.title_manually_set THEN RETURN NULL;END IF;
  SELECT scope_revision_id INTO previous FROM session_title_heads WHERE workspace_id=w AND session_id=s;
  IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
 ELSIF k='compact_summary' THEN
  IF p<>s OR target.compact_boundary_sequence IS DISTINCT FROM expected_cursor THEN RETURN NULL;END IF;
 ELSIF k='message_annotation' THEN
  IF NOT EXISTS(SELECT 1 FROM session_messages WHERE workspace_id=w AND session_id=s AND id=p)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) node WHERE node->>'resourceKind'='session_message' AND node->>'resourceId'=p::text) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  SELECT scope_revision_id INTO previous FROM session_message_annotation_heads WHERE workspace_id=w AND session_id=s AND message_id=p;
  IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
 ELSIF k='session_state' THEN
  SELECT scope_revision_id INTO previous FROM session_state WHERE id=p AND session_id=s;
  IF FOUND THEN IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
  ELSIF expected_revision IS NOT NULL OR expected_generation IS NULL THEN RETURN NULL;END IF;
 ELSE
  IF expected_revision IS NOT NULL OR EXISTS(SELECT 1 FROM episodic_memories WHERE id=p) THEN RETURN NULL;END IF;
 END IF;
 field_currents:=NULL;
 IF (SELECT encode(sha256(convert_to(to_jsonb(catalog_proc)::text,'UTF8')),'hex') FROM pg_proc catalog_proc WHERE oid='application_native_context_fields_current()'::regprocedure)='__GUARD__' THEN
  IF application_native_context_fields_current() IS TRUE THEN
   field_currents:=read_native_context_field_currents(w,sources);
   IF (SELECT encode(sha256(convert_to(to_jsonb(catalog_proc)::text,'UTF8')),'hex') FROM pg_proc catalog_proc WHERE oid='application_native_context_fields_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN field_currents:=NULL;
   ELSIF application_native_context_fields_current() IS NOT TRUE THEN field_currents:=NULL;END IF;
  END IF;
 END IF;
 -- Retry only this read-only pass if its optional helper contract changed.
 LOOP
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   IF field_currents IS NOT NULL THEN
    current_source:=(field_currents->(source->>'resourceId'))||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
   ELSE
   evaluated:=application_session_eval_field(w,(source->>'resourceId')::uuid,source->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
   END IF;
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
  IF k='session_title' AND source->>'resourceKind'='application_field'
   AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(source->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
   projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(source->>'resourceId')::uuid],ARRAY[source->>'version']);
   IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
    OR projection->'root' IS DISTINCT FROM source
    OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
    IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE
     OR label->>'userId' IS NOT NULL AND label->>'userId' IS DISTINCT FROM parent->>'userId'
      AND (parent->>'userId' IS NOT NULL OR label->>'userId' IS DISTINCT FROM actor::text) THEN
     RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
    IF sensitivity_rank(label->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=label->>'sensitivity';END IF;
    teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(label->'compartments'))) item ORDER BY item);
    projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(label->'projectIds')::uuid)) item ORDER BY item);
   END LOOP;
   -- Metadata is not admission. Repeat the exact current H read after discovery.
   current_source:=read_admitted_application_field_snapshot(w,(source->>'resourceId')::uuid,source->>'version');
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
    OR (current_source-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM source THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) item ORDER BY item);
  projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) item ORDER BY item);
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 IF field_currents IS NOT NULL THEN
  IF (SELECT encode(sha256(convert_to(to_jsonb(catalog_proc)::text,'UTF8')),'hex') FROM pg_proc catalog_proc WHERE oid='application_native_context_fields_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN
   field_currents:=NULL;memo:='{}';current_source:=NULL;evaluated:=NULL;projection:=NULL;label:=NULL;CONTINUE;
  END IF;
  IF application_native_context_fields_current() IS NOT TRUE THEN
   field_currents:=NULL;memo:='{}';current_source:=NULL;evaluated:=NULL;projection:=NULL;label:=NULL;CONTINUE;
  END IF;
 END IF;
 EXIT;
 END LOOP;
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
 ELSIF k='session_title' THEN
  INSERT INTO session_title_heads(workspace_id,session_id,scope_revision_id) VALUES(w,s,i)
   ON CONFLICT(session_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id;
  UPDATE sessions SET title=NULL,title_manually_set=(payload->>'manual')::boolean WHERE workspace_id=w AND id=s;
 ELSIF k='message_annotation' THEN
  INSERT INTO session_message_annotation_heads(message_id,workspace_id,session_id,scope_revision_id) VALUES(p,w,s,i)
   ON CONFLICT(message_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id;
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
 IF k='session_title' THEN
  memo:='{}';parent:=lock_native_session_context_publication(w,s);
 field_currents:=NULL;
 IF (SELECT encode(sha256(convert_to(to_jsonb(catalog_proc)::text,'UTF8')),'hex') FROM pg_proc catalog_proc WHERE oid='application_native_context_fields_current()'::regprocedure)='__GUARD__' THEN
  IF application_native_context_fields_current() IS TRUE THEN
   field_currents:=read_native_context_field_currents(w,sources);
   IF (SELECT encode(sha256(convert_to(to_jsonb(catalog_proc)::text,'UTF8')),'hex') FROM pg_proc catalog_proc WHERE oid='application_native_context_fields_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN field_currents:=NULL;
   ELSIF application_native_context_fields_current() IS NOT TRUE THEN field_currents:=NULL;END IF;
  END IF;
 END IF;
 -- Retry only this read-only pass if its optional helper contract changed.
 LOOP
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   IF field_currents IS NOT NULL THEN
    current_source:=(field_currents->(source->>'resourceId'))||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
   ELSE
   evaluated:=application_session_eval_field(w,(source->>'resourceId')::uuid,source->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
   END IF;
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
  IF k='session_title' AND source->>'resourceKind'='application_field'
   AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(source->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
   projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(source->>'resourceId')::uuid],ARRAY[source->>'version']);
   IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
    OR projection->'root' IS DISTINCT FROM source
    OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
    IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE
     OR label->>'userId' IS NOT NULL AND label->>'userId' IS DISTINCT FROM parent->>'userId'
      AND (parent->>'userId' IS NOT NULL OR label->>'userId' IS DISTINCT FROM actor::text) THEN
     RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
    IF sensitivity_rank(label->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=label->>'sensitivity';END IF;
    teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(label->'compartments'))) item ORDER BY item);
    projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(label->'projectIds')::uuid)) item ORDER BY item);
   END LOOP;
   -- Metadata is not admission. Repeat the exact current H read after discovery.
   current_source:=read_admitted_application_field_snapshot(w,(source->>'resourceId')::uuid,source->>'version');
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
    OR (current_source-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM source THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) item ORDER BY item);
  projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) item ORDER BY item);
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 IF field_currents IS NOT NULL THEN
  IF (SELECT encode(sha256(convert_to(to_jsonb(catalog_proc)::text,'UTF8')),'hex') FROM pg_proc catalog_proc WHERE oid='application_native_context_fields_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN
   field_currents:=NULL;memo:='{}';current_source:=NULL;evaluated:=NULL;projection:=NULL;label:=NULL;CONTINUE;
  END IF;
  IF application_native_context_fields_current() IS NOT TRUE THEN
   field_currents:=NULL;memo:='{}';current_source:=NULL;evaluated:=NULL;projection:=NULL;label:=NULL;CONTINUE;
  END IF;
 END IF;
 EXIT;
 END LOOP;
  IF NOT EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i
   AND r.sensitivity=floor_tier AND r.compartments=teams AND r.project_ids=projects) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('source',jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,'version','1',
  'userId',parent->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects),
  'createdAt',created,'userId',target.user_id,'assistantId',target.assistant_id);
END $updated$,'__GUARD__',guard_pin);
 EXECUTE replace(definition,original,updated);
 IF application_native_context_fields_current() IS NOT TRUE OR application_native_covered_evidence_helpers_current() IS NOT TRUE
 OR application_native_dependency_batch_helpers_current() IS NOT TRUE OR application_native_field_reference_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'Native context field final guards failed';END IF;
END $install$;
COMMIT;
