BEGIN;
-- [COMP:api/application-persistence] Preserve direct native Memory-history purpose
-- in canonical transcript publication. Only two existing unpinned bodies change.
DO $transcript_prerequisites$
DECLARE item jsonb;actual pg_proc;canonical_owner oid;actual_acl jsonb;expected_acl jsonb;guard pg_proc;
BEGIN
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid='public.memories'::regclass;
 FOR item IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"public.prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)","body":"9fb9c28d3cc51e700a195eaff5d3bc7d66b1a73e4c6a6dbe785d69be9c15e551","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"prepare_native_session_message_batch","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","producer","sources","target"],"proargtypes":["2950","2950","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.validate_application_field_dependencies()","body":"ecb960d267db91b7db3f1ce9338da5e63f93e331d8874e282e8e4c24f6b10c8e","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_application_field_dependencies","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)","body":"9679b9d4f9b9a19549de30e1ad077957fd404b21784a2cc209dbe4603717b30f","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_message_batch","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","payloads","producer","sources","target"],"proargtypes":["2950","2950","3802","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])","body":"9d27f33becac8535d1faa949d629b5f460955bfc4a0191f5cb26c3e26975645d","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])","body":"02b30a1673331cf5468fd09bd87db98a2e2a7cea528e5c4c5973b36a61ff7b2e","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_attended_memory_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_memory_history_status(uuid,uuid,text)","body":"129079ae5b1096a988366358b0a45ca0d8da8102361a3df8e25d48d0e510c6ce","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_history_status","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v"],"proargtypes":["2950","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$expected$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM item->>'body'
   OR actual.proowner IS DISTINCT FROM canonical_owner OR actual.pronamespace IS DISTINCT FROM 'public'::regnamespace
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM item->'metadata' THEN
   RAISE EXCEPTION 'Native history transcript function prerequisite changed: %',item->>'signature';END IF;
  SELECT jsonb_agg(jsonb_build_array(a.grantee,a.grantor,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
   INTO actual_acl FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
  SELECT jsonb_agg(jsonb_build_array(g,canonical_owner,'EXECUTE',false) ORDER BY g) INTO expected_acl
   FROM (SELECT canonical_owner AS g UNION SELECT oid FROM pg_roles WHERE rolname='app_user' AND (item->>'runtime')::boolean) grants;
  IF actual_acl IS DISTINCT FROM expected_acl THEN RAISE EXCEPTION 'Native history transcript ACL prerequisite changed: %',item->>'signature';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.scope_derivation_sources'::regclass
  AND t.tgfoid='public.validate_application_field_dependencies()'::regprocedure
  AND (to_jsonb(t)-ARRAY['oid','tgrelid','tgfoid','tgconstraint'])=$trigger${"tgargs":"\\x","tgattr":[],"tgname":"application_field_derivation_dependencies","tgqual":null,"tgtype":21,"tgnargs":0,"tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":true,"tgisinternal":false,"tgconstrindid":"0","tgconstrrelid":"0","tginitdeferred":true}$trigger$::jsonb) THEN
  RAISE EXCEPTION 'Native history transcript deferred trigger prerequisite changed';END IF;
 SELECT * INTO guard FROM pg_proc WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 IF guard.proowner IS DISTINCT FROM canonical_owner OR application_memory_statement_helpers_current() IS NOT TRUE
  OR guard.prosrc NOT LIKE '%SELECT count(*)=122%'
  OR (SELECT count(*) FROM regexp_matches(guard.prosrc,'::oid,''[0-9a-f]{64}''::text','g'))<>122 THEN
  RAISE EXCEPTION 'Native history transcript Memory guard prerequisite changed';END IF;
END $transcript_prerequisites$;
DO $transcript_body$
DECLARE port regprocedure:='public.prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)'::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;
 guard_before jsonb;trigger_before jsonb;helpers_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO helpers_before FROM pg_proc p WHERE p.oid=ANY(ARRAY[
  'public.publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)'::regprocedure,
  'public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,
  'public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure,
  'public.application_memory_history_status(uuid,uuid,text)'::regprocedure]::oid[]);
 after:=$replacement$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;node jsonb;current_source jsonb;
 expanded jsonb:=sources;retained jsonb:='[]';dependency record;root_kinds text[];root_ids uuid[];root_versions text[];
 floor_tier text;teams text[];projects uuid[];memo jsonb:='{}';evaluated jsonb;stored session_messages;derivation uuid;source_scope jsonb;projection jsonb;label jsonb;
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
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history transcript body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM '56495fea6eade9f397d21dc725501159dc3f928c2786dcb005dedc4513e0f30d'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE p.oid=ANY(ARRAY[
   'public.publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)'::regprocedure,
   'public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,
   'public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure,
   'public.application_memory_history_status(uuid,uuid,text)'::regprocedure]::oid[])) IS DISTINCT FROM helpers_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history transcript body or security metadata changed';END IF;
END $transcript_body$;
DO $transcript_body$
DECLARE port regprocedure:='public.validate_application_field_dependencies()'::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;
 guard_before jsonb;trigger_before jsonb;helpers_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO helpers_before FROM pg_proc p WHERE p.oid=ANY(ARRAY[
  'public.publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)'::regprocedure,
  'public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,
  'public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure,
  'public.application_memory_history_status(uuid,uuid,text)'::regprocedure]::oid[]);
 after:=$replacement$
DECLARE output scope_derivations; dependency record; source jsonb; current jsonb; has_fields boolean:=false;
 history boolean:=false;projection jsonb;label jsonb;fields jsonb;
BEGIN
 SELECT * INTO output FROM scope_derivations WHERE workspace_id=NEW.workspace_id AND id=NEW.derivation_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Direct history keeps its purpose only for canonical titles or stored messages.
 history:=NEW.source_kind='application_field' AND output.resource_version='1'
  AND ((output.resource_kind='session_context_revision'
   AND EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=output.workspace_id AND r.id=output.resource_id
    AND r.parent_kind='session_title' AND r.parent_id=r.session_id AND r.user_id IS NOT DISTINCT FROM output.user_id
    AND r.assistant_id IS NOT DISTINCT FROM output.assistant_id AND r.sensitivity=output.sensitivity
    AND r.compartments=output.compartments AND r.project_ids=output.project_ids))
   OR (output.resource_kind='session_message'
    AND EXISTS(SELECT 1 FROM session_messages m JOIN sessions s ON s.id=m.session_id AND s.workspace_id=m.workspace_id
     WHERE m.workspace_id=output.workspace_id AND m.id=output.resource_id AND m.scope_version=1 AND m.scope_held IS FALSE
      AND m.user_id IS NOT DISTINCT FROM output.user_id AND m.assistant_id IS NOT DISTINCT FROM output.assistant_id
      AND m.sensitivity=output.sensitivity AND m.compartments=output.compartments AND m.project_ids=output.project_ids)))
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
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history transcript body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM '6f86fbd4c0cc5c77e69a91c6c0c211b0b70c69f49dfd89b3ec85eddff39d9091'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE p.oid=ANY(ARRAY[
   'public.publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)'::regprocedure,
   'public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,
   'public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure,
   'public.application_memory_history_status(uuid,uuid,text)'::regprocedure]::oid[])) IS DISTINCT FROM helpers_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history transcript body or security metadata changed';END IF;
END $transcript_body$;
COMMIT;
