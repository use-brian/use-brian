BEGIN;
-- [COMP:api/application-persistence] Preserve direct native Memory-history title purpose.
-- Only four existing bodies change; accepted helpers, ACLs and122 pins are immutable.
DO $title_prerequisites$
DECLARE item jsonb;actual pg_proc;canonical_owner oid;actual_acl jsonb;expected_acl jsonb;
BEGIN
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid='public.memories'::regclass;
 FOR item IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"public.session_context_revision_allowed(uuid,uuid)","body":"388329a1ab8bfa72030a9d50e402d19f549a7b2d9c819c176e4c38c37d2d5d09","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"session_context_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.validate_application_field_dependencies()","body":"610b645eff660e96b9e9dac4d484d722cafb70a1c1766e39232217a832430774","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_application_field_dependencies","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)","body":"6e3a5a3dcf04a89d516963ed4d5da49d42b7c152662dbd3a1abf7e6804df040b","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_context_revision","prorows":0,"pronargs":11,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","k","p","i","payload","producer","sources","expected_revision","expected_generation","expected_cursor"],"proargtypes":["2950","2950","25","2950","2950","3802","25","3802","2950","20","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])","body":"1f84baac32c7dec94a4811302946eedb56431452ab1e5d91c6992b6f85535920","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])","body":"02b30a1673331cf5468fd09bd87db98a2e2a7cea528e5c4c5973b36a61ff7b2e","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_attended_memory_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_memory_history_status(uuid,uuid,text)","body":"129079ae5b1096a988366358b0a45ca0d8da8102361a3df8e25d48d0e510c6ce","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_history_status","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v"],"proargtypes":["2950","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$expected$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM item->>'body'
   OR actual.proowner IS DISTINCT FROM canonical_owner OR actual.pronamespace IS DISTINCT FROM 'public'::regnamespace
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM item->'metadata' THEN
   RAISE EXCEPTION 'Native history title function prerequisite changed: %',item->>'signature';END IF;
  SELECT jsonb_agg(jsonb_build_array(a.grantee,a.grantor,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
   INTO actual_acl FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
  SELECT jsonb_agg(jsonb_build_array(g,canonical_owner,'EXECUTE',false) ORDER BY g) INTO expected_acl
   FROM (SELECT canonical_owner AS g UNION SELECT oid FROM pg_roles WHERE rolname='app_user' AND (item->>'runtime')::boolean) grants;
  IF actual_acl IS DISTINCT FROM expected_acl THEN RAISE EXCEPTION 'Native history title ACL prerequisite changed: %',item->>'signature';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.scope_derivation_sources'::regclass
  AND tgname='application_field_derivation_dependencies' AND tgfoid='public.validate_application_field_dependencies()'::regprocedure
  AND NOT tgisinternal AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND tgnargs=0 AND tgqual IS NULL) THEN
  RAISE EXCEPTION 'Native history title deferred trigger prerequisite changed';END IF;
 IF application_memory_statement_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native history title Memory guard prerequisite changed';END IF;
END $title_prerequisites$;
DO $title_body$
DECLARE port regprocedure:='public.validate_application_field_dependencies() '::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;guard_before jsonb;trigger_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 after:=$replacement$
DECLARE output scope_derivations; dependency record; source jsonb; current jsonb; has_fields boolean:=false;
 history boolean:=false;projection jsonb;label jsonb;fields jsonb;
BEGIN
 SELECT * INTO output FROM scope_derivations WHERE workspace_id=NEW.workspace_id AND id=NEW.derivation_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- A direct history edge keeps its own purpose only for canonical titles.
 history:=NEW.source_kind='application_field' AND output.resource_kind='session_context_revision'
  AND output.resource_version='1'
  AND EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=output.workspace_id AND r.id=output.resource_id
   AND r.parent_kind='session_title' AND r.parent_id=r.session_id AND r.user_id IS NOT DISTINCT FROM output.user_id
   AND r.assistant_id IS NOT DISTINCT FROM output.assistant_id AND r.sensitivity=output.sensitivity
   AND r.compartments=output.compartments AND r.project_ids=output.project_ids)
  AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=NEW.workspace_id AND f.id=NEW.source_id
   AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history');
 IF history THEN
  current:=read_admitted_application_field_snapshot(NEW.workspace_id,NEW.source_id,NEW.source_version);
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM NEW.source_version THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  projection:=read_native_attended_memory_evidence(NEW.workspace_id,ARRAY[NEW.source_kind],ARRAY[NEW.source_id],ARRAY[NEW.source_version]);
  IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
   OR projection->'root' IS DISTINCT FROM (current-ARRAY['held','validTo','retractedAt'])
   OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
   IF workflow_evidence_envelope_visible(NEW.workspace_id,label) IS NOT TRUE
    OR label->>'userId' IS NOT NULL AND label->>'userId' IS DISTINCT FROM output.user_id::text
     AND (output.user_id IS NOT NULL OR label->>'userId' IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),''))
    OR sensitivity_rank(label->>'sensitivity')>sensitivity_rank(output.sensitivity)
    OR NOT to_jsonb(output.compartments)@>(label->'compartments') OR NOT to_jsonb(output.project_ids)@>(label->'projectIds') THEN
    RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('node_version',d.node_version,'source',d.source)),'[]') INTO fields
   FROM read_native_session_field_dependencies(NEW.workspace_id,ARRAY[NEW.source_kind],ARRAY[NEW.source_id],ARRAY[NEW.source_version]) d;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) d WHERE d->>'node_version'=NEW.source_version
    AND d#>>'{source,resourceId}'=NEW.source_id::text) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('node_version',d.node_version,'source',d.source)),'[]') INTO fields
   FROM read_application_field_dependencies(NEW.workspace_id,ARRAY[NEW.source_kind],ARRAY[NEW.source_id],ARRAY[NEW.source_version]) d;
 END IF;
 FOR dependency IN SELECT d->>'node_version' AS node_version,d->'source' AS source FROM jsonb_array_elements(fields) d LOOP
  has_fields:=true;source:=dependency.source;
  current:=application_current_field_snapshot(NEW.workspace_id,(source->>'resourceId')::uuid);
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM dependency.node_version THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM scope_derivation_sources s WHERE s.workspace_id=NEW.workspace_id AND s.derivation_id=NEW.derivation_id
   AND s.source_kind='application_field' AND s.source_id=(source->>'resourceId')::uuid AND s.source_version=dependency.node_version) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM output.user_id::text
   AND source->>'userId' IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
   OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF NOT has_fields THEN RETURN NULL; END IF;
 FOR dependency IN SELECT * FROM read_external_source_dependencies(NEW.workspace_id,ARRAY[NEW.source_kind],ARRAY[NEW.source_id],ARRAY[NEW.source_version]) LOOP
  IF dependency.source IS NULL OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
   OR NOT external_source_retention_allowed(NEW.workspace_id,(dependency.source->>'resourceId')::uuid,dependency.node_version)
   OR NOT EXISTS(SELECT 1 FROM scope_derivation_sources s WHERE s.workspace_id=NEW.workspace_id AND s.derivation_id=NEW.derivation_id
    AND s.source_kind='external_source' AND s.source_id=(dependency.source->>'resourceId')::uuid AND s.source_version=dependency.node_version) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
  source:=dependency.source;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023'; END IF;
 END LOOP;
 RETURN NULL;
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history title body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM 'ecb960d267db91b7db3f1ce9338da5e63f93e331d8874e282e8e4c24f6b10c8e'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history title body or security metadata changed';END IF;
END $title_body$;
DO $title_body$
DECLARE port regprocedure:='public.publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer) '::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;guard_before jsonb;trigger_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 after:=$replacement$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;target sessions;
 source jsonb;current_source jsonb;floor_tier text;teams text[];projects uuid[];previous uuid;derivation uuid;created timestamptz;memo jsonb:='{}';evaluated jsonb;projection jsonb;label jsonb;
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
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   evaluated:=application_session_eval_field(w,(source->>'resourceId')::uuid,source->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
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
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   evaluated:=application_session_eval_field(w,(source->>'resourceId')::uuid,source->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
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
  IF NOT EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i
   AND r.sensitivity=floor_tier AND r.compartments=teams AND r.project_ids=projects) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('source',jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,'version','1',
  'userId',parent->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects),
  'createdAt',created,'userId',target.user_id,'assistantId',target.assistant_id);
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history title body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM '7dc3e78f0668b20dc10de455c81537c1e015b84fad1521d7f3e9b27cf288a8e7'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history title body or security metadata changed';END IF;
END $title_body$;
DO $title_body$
DECLARE port regprocedure:='public.session_context_revision_allowed(uuid,uuid) '::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;guard_before jsonb;trigger_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 after:=$replacement$
DECLARE root jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 child_kinds text[];child_ids uuid[];child_versions text[];eligible boolean;position integer;admitted jsonb;dependency record;
 seen jsonb:='[]';current_source jsonb;
BEGIN
 root:=read_entity_derivation_source(w,'session_context_revision',i);
 IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
 IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(s.source_kind='application_field' AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO child_kinds,child_ids,child_versions,eligible
 FROM session_context_scope_revisions r JOIN scope_derivations d ON d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
  AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
  AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE r.workspace_id=w AND r.id=i AND r.parent_kind='session_title' AND r.parent_id=r.session_id AND r.scope_version=1;
 IF eligible IS TRUE AND EXISTS(SELECT 1 FROM application_scope_lineage(w,child_kinds,child_ids,child_versions) n WHERE n.kind='session_context_revision') THEN eligible:=false;END IF;

  IF eligible IS TRUE THEN
   IF root->>'version' IS DISTINCT FROM '1' OR application_reader_envelope_visible(w,root) IS NOT TRUE THEN RETURN false;END IF;
   FOR position IN 1..cardinality(child_ids) LOOP
    admitted:=read_admitted_application_field_snapshot(w,child_ids[position],child_versions[position]);
    IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM child_versions[position] THEN RETURN false;END IF;
   END LOOP;
   FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,child_kinds,child_ids,child_versions) LOOP
    admitted:=read_admitted_application_field_snapshot(w,(dependency.source->>'resourceId')::uuid,dependency.node_version);
    IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM dependency.node_version THEN RETURN false;END IF;
    seen:=seen||jsonb_build_array(jsonb_build_array(dependency.source->>'resourceId',dependency.node_version));
   END LOOP;
   IF jsonb_array_length(seen)=0 THEN RETURN false;END IF;
   FOR position IN 1..cardinality(child_ids) LOOP
    IF NOT seen @> jsonb_build_array(jsonb_build_array(child_ids[position]::text,child_versions[position])) THEN RETURN false;END IF;
   END LOOP;
   FOR dependency IN SELECT * FROM read_external_source_dependencies(w,child_kinds,child_ids,child_versions) LOOP
    current_source:=external_source_snapshot(w,(dependency.source->>'resourceId')::uuid);
    IF dependency.source IS NULL OR dependency.source->>'workspaceId' IS DISTINCT FROM w::text
     OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
     OR current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
     OR current_source->>'version' IS DISTINCT FROM dependency.node_version
     OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE
     OR application_reader_envelope_visible(w,current_source) IS NOT TRUE THEN RETURN false;END IF;
   END LOOP;
   RETURN true;
  END IF;
 END IF;
 RETURN root IS NOT NULL AND root->>'held'='false'
  AND application_canonical_ancestry_allowed(w,'session_context_revision',i,'1') IS TRUE;
END
$replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history title body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM '03add22b1ea7900476c23a91a119beeeaa71504c8a0db93c83adf20783c0b7bf'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history title body or security metadata changed';END IF;
END $title_body$;
DO $title_body$
DECLARE port regprocedure:='public.read_native_session_field_dependencies(uuid,text[],uuid[],text[]) '::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;guard_before jsonb;trigger_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 after:=$replacement$
DECLARE dependency record;item jsonb;rows_json jsonb:='[]';memo jsonb:='{}';result jsonb;admitted jsonb;native_only boolean:=true;belongs boolean;position integer;
 resource application_field_resources;observation application_field_observations;proof jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;child_kinds text[];child_ids uuid[];child_versions text[];
 eligible boolean;eligible_roots jsonb:='{}';root_shape jsonb;
BEGIN

 -- A native immutable title delegates its complete stored direct fields only.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND (actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))) THEN
  FOR position IN 1..cardinality(ids) LOOP
   IF kinds[position]<>'session_context_revision' THEN CONTINUE;END IF;

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(s.source_kind='application_field' AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO child_kinds,child_ids,child_versions,eligible
 FROM session_context_scope_revisions r JOIN scope_derivations d ON d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
  AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
  AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE r.workspace_id=w AND r.id=ids[position] AND r.parent_kind='session_title' AND r.parent_id=r.session_id AND r.scope_version=1;
 IF eligible IS TRUE AND EXISTS(SELECT 1 FROM application_scope_lineage(w,child_kinds,child_ids,child_versions) n WHERE n.kind='session_context_revision') THEN eligible:=false;END IF;

   IF eligible IS TRUE THEN
    eligible_roots:=eligible_roots||jsonb_build_object(position::text,jsonb_build_object('kinds',child_kinds,'ids',child_ids,'versions',child_versions));
   END IF;
  END LOOP;
  IF eligible_roots<>'{}'::jsonb THEN
   FOR position IN 1..cardinality(ids) LOOP
    root_shape:=eligible_roots->position::text;
    IF root_shape IS NULL THEN
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]);
    ELSE
     IF versions[position] IS DISTINCT FROM '1' OR session_context_revision_allowed(w,ids[position]) IS NOT TRUE THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     SELECT array_agg(value) INTO child_kinds FROM jsonb_array_elements_text(root_shape->'kinds');
     SELECT array_agg(value::uuid) INTO child_ids FROM jsonb_array_elements_text(root_shape->'ids');
     SELECT array_agg(value) INTO child_versions FROM jsonb_array_elements_text(root_shape->'versions');
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,child_kinds,child_ids,child_versions);
    END IF;
   END LOOP;
   RETURN;
  END IF;
 END IF;

 -- Each original root keeps its own purpose before union/deduplication.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND EXISTS(SELECT 1 FROM unnest(kinds,ids) r(kind,id) JOIN application_field_resources f ON f.workspace_id=w AND f.id=r.id
    WHERE r.kind='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
  FOR position IN 1..cardinality(ids) LOOP
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=ids[position]
    AND kinds[position]='application_field' AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='memory' AND selection='history';
   IF NOT FOUND THEN
    RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]);
    CONTINUE;
   END IF;
   admitted:=read_admitted_application_field_snapshot(w,ids[position],versions[position]);
   IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM versions[position] THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   proof:=application_memory_history_status(w,resource.resource_id,resource.selected_version);
   IF proof IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   FOR dependency IN SELECT * FROM read_application_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]) LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'ownFields') f
      WHERE f->>'id'=dependency.source->>'resourceId' AND f->>'version'=dependency.node_version)
     AND NOT EXISTS(SELECT 1 FROM unnest(kinds,ids,versions) r(kind,id,version) WHERE r.kind='application_field'
      AND r.id=(dependency.source->>'resourceId')::uuid AND r.version=dependency.node_version) THEN CONTINUE;END IF;
    admitted:=read_admitted_application_field_snapshot(w,(dependency.source->>'resourceId')::uuid,dependency.node_version);
    IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    node_version:=dependency.node_version;source:=dependency.source;RETURN NEXT;
   END LOOP;
  END LOOP;
  RETURN;
 END IF;
 FOR dependency IN SELECT * FROM read_application_field_dependencies(w,kinds,ids,versions) LOOP
  SELECT origin='{"kind":"native","moduleKey":"native"}'::jsonb AND type_key IN('session_message','session_message_annotation') INTO belongs
   FROM application_field_resources WHERE workspace_id=w AND id=(dependency.source->>'resourceId')::uuid;
  IF belongs IS DISTINCT FROM true THEN native_only:=false;END IF;
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
 END LOOP;
 IF NOT native_only THEN RETURN QUERY SELECT * FROM read_admitted_application_field_dependencies(w,kinds,ids,versions);RETURN;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(rows_json) LOOP
  result:=application_session_eval_field(w,(item#>>'{source,resourceId}')::uuid,item->>'version',memo);memo:=coalesce(result->'memo',memo);admitted:=result->'value';
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(rows_json);
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history title body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM '9d27f33becac8535d1faa949d629b5f460955bfc4a0191f5cb26c3e26975645d'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history title body or security metadata changed';END IF;
END $title_body$;
COMMIT;
