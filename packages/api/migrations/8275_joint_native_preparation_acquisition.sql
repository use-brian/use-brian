-- [COMP:api/native-turn-frame] Joint native preparation acquisition owner.
-- Applied 8269-8274, the canonical capture and every registry member stay
-- unchanged. This migration adds one boundary owner beside them; the kernel
-- adopts it separately. See docs/plans/oss-chat-m1-physical-and-durable-design.md
-- "Joint native preparation acquisition checkpoint (2026-11-16)".
BEGIN;
DO $owner_roles$ DECLARE actor pg_roles;runtime pg_roles;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);BEGIN
 SELECT * INTO STRICT actor FROM pg_roles WHERE rolname=current_user;SELECT * INTO STRICT runtime FROM pg_roles WHERE rolname='app_user';
 IF actor.oid<>owner_id OR actor.rolsuper OR actor.rolbypassrls OR runtime.rolsuper OR runtime.rolbypassrls OR runtime.rolcreaterole OR runtime.rolcreatedb OR runtime.rolreplication OR runtime.rolinherit
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime.oid OR roleid=runtime.oid)
 OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=runtime.oid) OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=runtime.oid) THEN RAISE EXCEPTION 'installation_runtime_role_unsafe';END IF;
END $owner_roles$;
SET LOCAL search_path=pg_catalog,pg_temp,public;

-- The joint owner composes only already-registered canonical callees. Refuse
-- before DDL when the installed executable root, the canonical capture's own
-- reviewed guard pin, or any callee contract is not the expected installation.
DO $preparation_prerequisites$ DECLARE guard_pin text;capture_source text;callee text;BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'preparation_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8274_inputtable_executable_contracts.sql') THEN RAISE EXCEPTION 'preparation_predecessor_missing';END IF;
 IF to_regprocedure('public.capture_conversation_preparation(uuid,jsonb,jsonb,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'preparation_owner_already_exists';END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_pin FROM pg_proc p WHERE p.oid='public.native_turn_helpers_current()'::regprocedure;
 SELECT p.prosrc INTO capture_source FROM pg_proc p WHERE p.oid='public.capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)'::regprocedure;
 -- Entry and closing fence in the canonical capture name the same guard record.
 IF guard_pin IS NULL OR capture_source IS NULL
  OR (length(capture_source)-length(replace(capture_source,'IS DISTINCT FROM '''||guard_pin||'''','')))/length('IS DISTINCT FROM '''||guard_pin||'''')<>2
 THEN RAISE EXCEPTION 'preparation_guard_pin_changed';END IF;
 IF public.native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'preparation_predecessor_contract_changed';END IF;
 IF strpos(capture_source,'read_native_attended_memory_evidence(w,')=0 OR NOT EXISTS(SELECT 1 FROM pg_proc p
  WHERE p.oid='public.read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure AND strpos(p.prosrc,'read_admitted_application_field_snapshot(w,')>0)
 THEN RAISE EXCEPTION 'preparation_adapter_owner_changed';END IF;
 FOREACH callee IN ARRAY ARRAY['capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)','conversation_dag(uuid,jsonb,jsonb)',
  'conversation_source_edges(uuid,text,uuid,text)','native_turn_context()','read_native_attended_memory_evidence(uuid,text[],uuid[],text[])',
  'read_admitted_application_field_snapshot(uuid,uuid,text)','read_scope_source(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])',
  'read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)','application_query_scope_valid(jsonb)',
  'application_query_scope_admits_point(jsonb,jsonb)'] LOOP
  -- Registry membership is what the runtime guard authenticates before use.
  -- The two independent family adapters keep their own owners, exactly as the
  -- canonical capture and recorded-field snapshot reader already call them.
  IF NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=callee)
   AND callee NOT IN('read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','read_admitted_application_field_snapshot(uuid,uuid,text)')
  THEN RAISE EXCEPTION 'preparation_callee_unregistered: %',callee;END IF;
  IF to_regprocedure('public.'||callee) IS NULL THEN RAISE EXCEPTION 'preparation_callee_missing: %',callee;END IF;
 END LOOP;
END $preparation_prerequisites$;

-- One statement is one admitted frame for one preparation boundary. Each cohort
-- is projected exactly as an independent capture_conversation_evidence(w,roots)
-- would project it; nothing here is retained or reused by another statement.
CREATE FUNCTION public.capture_conversation_preparation(w uuid, cohorts jsonb, fields jsonb DEFAULT NULL::jsonb, authority jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE self_digest constant text:='0000000000000000000000000000000000000000000000000000000000000000';
 guard_pin text;cohort_count integer;cohort integer;roots jsonb;membership jsonb;physical jsonb;members jsonb;graph_roots jsonb:='[]';
 memo jsonb;context jsonb;policy_revision jsonb;authority_facts jsonb;results jsonb[];dispatch text[];n jsonb;source jsonb;
 immutable jsonb;currents jsonb;observation application_field_observations;selector record;candidate record;candidate_sources jsonb;
 dependency record;scanned jsonb:='{}';selector_key text;attempts integer;selector_attempts integer;external_found boolean;denied boolean;
 field_ids uuid[];field_versions text[];entry record;snapshots jsonb:='[]';snapshot jsonb;
BEGIN
 -- Entry fence, once per boundary. The guard pin is the one the canonical
 -- capture embeds; this owner never holds a separate guard literal.
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_pin FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure;
 IF guard_pin IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc c WHERE c.oid='capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)'::regprocedure
  AND strpos(c.prosrc,'IS DISTINCT FROM '''||guard_pin||'''')>0) THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF (SELECT encode(sha256(convert_to(jsonb_set(to_jsonb(p),'{prosrc}',to_jsonb(replace(p.prosrc,self_digest,repeat('0',64))))::text,'UTF8')),'hex')
  FROM pg_proc p WHERE p.oid='capture_conversation_preparation(uuid,jsonb,jsonb,jsonb)'::regprocedure) IS DISTINCT FROM self_digest
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(cohorts) IS DISTINCT FROM 'array' OR jsonb_array_length(cohorts) NOT BETWEEN 0 AND 8
  OR jsonb_array_length(cohorts)=0 AND fields IS NULL AND authority IS NULL
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(cohorts) g WHERE jsonb_typeof(g) IS DISTINCT FROM 'array' OR jsonb_array_length(g) NOT BETWEEN 1 AND 4096)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(cohorts) g CROSS JOIN jsonb_array_elements(g) AS input(root) WHERE jsonb_typeof(input.root) IS DISTINCT FROM 'object'
   OR input.root-ARRAY['kind','id','version']<>'{}' OR NOT input.root ?& ARRAY['kind','id','version'] OR jsonb_typeof(input.root->'kind') IS DISTINCT FROM 'string'
   OR jsonb_typeof(input.root->'version') IS DISTINCT FROM 'string' OR length(input.root->>'version') NOT BETWEEN 1 AND 256
   OR jsonb_typeof(input.root->'id') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(input.root->>'id','uuid'))
 THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
 IF fields IS NOT NULL THEN
  IF jsonb_typeof(fields) IS DISTINCT FROM 'object' OR fields-ARRAY['ids','versions']<>'{}' OR jsonb_typeof(fields->'ids') IS DISTINCT FROM 'array'
   OR jsonb_typeof(fields->'versions') IS DISTINCT FROM 'array' OR jsonb_array_length(fields->'ids') NOT BETWEEN 1 AND 4096
   OR jsonb_array_length(fields->'ids')<>jsonb_array_length(fields->'versions')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(fields->'ids') i WHERE jsonb_typeof(i) IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(i#>>'{}','uuid'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(fields->'versions') v WHERE jsonb_typeof(v) IS DISTINCT FROM 'string')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  SELECT array_agg((i#>>'{}')::uuid ORDER BY o) INTO field_ids FROM jsonb_array_elements(fields->'ids') WITH ORDINALITY x(i,o);
  SELECT array_agg(v#>>'{}' ORDER BY o) INTO field_versions FROM jsonb_array_elements(fields->'versions') WITH ORDINALITY x(v,o);
 END IF;
 SELECT jsonb_build_array(c.revision,p.revision) INTO policy_revision
  FROM application_policy_contract_epoch c CROSS JOIN application_policy_workspace_epochs p
  WHERE c.singleton AND p.workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 context:=native_turn_context();
 cohort_count:=jsonb_array_length(cohorts);
 results:=array_fill(NULL::jsonb,ARRAY[cohort_count]);dispatch:=array_fill('graph'::text,ARRAY[cohort_count]);
 -- Query-domain identities are internal dependencies, never source roots.
 FOR cohort IN 1..cohort_count LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(cohorts->(cohort-1)) root WHERE root->>'kind'='application_query_domain') THEN dispatch[cohort]:='independent';END IF;
 END LOOP;
 -- One source-edge closure, tagged by cohort. Membership never crosses cohorts.
 WITH RECURSIVE closure(cohort,kind,id,version) AS(
  SELECT g.position::integer,r->>'kind',(r->>'id')::uuid,r->>'version'
   FROM jsonb_array_elements(cohorts) WITH ORDINALITY g(roots,position) CROSS JOIN jsonb_array_elements(g.roots) r
   WHERE dispatch[g.position::integer]='graph'
  UNION SELECT c.cohort,e.kind,e.id,e.version FROM closure c CROSS JOIN LATERAL conversation_source_edges(w,c.kind,c.id,c.version) e
 ) SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') INTO membership FROM(SELECT * FROM closure LIMIT 4096*cohort_count+1) c;
 IF jsonb_array_length(membership)>4096*cohort_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(membership) x GROUP BY x->>'cohort' HAVING count(*)>4096)
 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(DISTINCT member.node-'cohort'),'[]') INTO physical FROM jsonb_array_elements(membership) member(node);
 IF jsonb_array_length(physical)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 FOR cohort IN 1..cohort_count LOOP
  CONTINUE WHEN dispatch[cohort]<>'graph';
  roots:=cohorts->(cohort-1);
  SELECT coalesce(jsonb_agg(DISTINCT x-'cohort'),'[]') INTO members FROM jsonb_array_elements(membership) x WHERE (x->>'cohort')::integer=cohort;
  -- A single Memory-history root keeps its purpose-specific adapter.
  IF jsonb_array_length(roots)=1 AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(roots->0->>'id')::uuid
   AND roots->0->>'kind'='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
   dispatch[cohort]:='memory_history';
   results[cohort]:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(roots->0->>'id')::uuid],ARRAY[roots->0->>'version']);
   CONTINUE;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(members) x WHERE x->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','memory','workspace_file','episode','recording','private_transcript'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(members) x JOIN application_field_resources f ON f.workspace_id=w AND f.id=(x->>'id')::uuid
    WHERE x->>'kind'='application_field' AND (f.origin IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
     OR f.type_key NOT IN('session_message','session_message_annotation','memory') OR f.type_key='memory' AND f.selection='history'))
  THEN dispatch[cohort]:='independent';CONTINUE;END IF;
  -- Memory query-domain candidate discovery, once per distinct selector and
  -- charged to every cohort that names it, with capture's per-cohort bound.
  attempts:=0;external_found:=false;
  FOR selector IN SELECT DISTINCT q.domain FROM jsonb_to_recordset(members) n(kind text,id uuid,version text)
   JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id AND n.kind='application_field'
   JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=n.version
   JOIN application_query_domains q ON q.workspace_id=w AND q.id=f.resource_id AND q.type_key=f.type_key AND q.origin=f.origin
   WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain' LOOP
   IF selector.domain->>'kind' IS DISTINCT FROM 'memory_query_domain_v1' OR application_query_scope_valid(selector.domain->'bounds') IS NOT TRUE
   THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   IF selector.domain->>'includeRetained' IS DISTINCT FROM 'true' THEN CONTINUE;END IF;
   selector_key:=selector.domain::text;
   IF NOT scanned ? selector_key THEN
    candidate_sources:='[]';selector_attempts:=0;
    FOR candidate IN SELECT id FROM memories WHERE workspace_id=w ORDER BY id LOOP
     selector_attempts:=selector_attempts+1;
     IF attempts+selector_attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
     source:=read_scope_source(w,'memory',candidate.id);
     IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR application_query_scope_admits_point(selector.domain->'bounds',source) IS NOT TRUE THEN CONTINUE;END IF;
     candidate_sources:=candidate_sources||jsonb_build_array(jsonb_build_object('kind','memory','id',candidate.id,'version',source->'version'));
    END LOOP;
    scanned:=scanned||jsonb_build_object(selector_key,jsonb_build_object('attempts',selector_attempts,'external',false));
    FOR dependency IN SELECT array_agg(cohort_source.node->>'kind') kinds,
     array_agg((cohort_source.node->>'id')::uuid) ids,array_agg(cohort_source.node->>'version') versions
     FROM jsonb_array_elements(candidate_sources) WITH ORDINALITY cohort_source(node,ord)
     GROUP BY (cohort_source.ord-1)/100 LOOP
     IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN
      scanned:=jsonb_set(scanned,ARRAY[selector_key,'external'],'true');EXIT;END IF;
    END LOOP;
   END IF;
   attempts:=attempts+(scanned->selector_key->>'attempts')::integer;
   IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   IF scanned->selector_key->>'external'='true' THEN external_found:=true;END IF;
  END LOOP;
  IF external_found THEN dispatch[cohort]:='independent';CONTINUE;END IF;
  SELECT coalesce(jsonb_agg(DISTINCT r),'[]') INTO graph_roots FROM(SELECT jsonb_array_elements(graph_roots) r UNION SELECT jsonb_array_elements(roots)) u;
 END LOOP;
 -- Native recorded-field snapshot roots join the same graph acquisition.
 IF field_ids IS NOT NULL THEN
  SELECT coalesce(jsonb_agg(DISTINCT r),'[]') INTO graph_roots FROM(SELECT jsonb_array_elements(graph_roots) r
   UNION SELECT jsonb_build_object('kind','application_field','id',input.id,'version',input.version)
   FROM unnest(field_ids,field_versions) input(id,version) JOIN application_field_resources f ON f.workspace_id=w AND f.id=input.id
   WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key IN('session_message','session_message_annotation')) u;
 END IF;
 IF graph_roots<>'[]' THEN memo:=conversation_dag(w,graph_roots,'[]');END IF;
 -- Graph-level family dispatch routes graph cohorts to their independent
 -- adapter; it never admits or refuses a cohort differently.
 IF memo->>'hasExternal'='true' OR memo IS NOT NULL AND memo->>'recordingEligible' IS DISTINCT FROM 'true' THEN
  FOR cohort IN 1..cohort_count LOOP IF dispatch[cohort]='graph' THEN dispatch[cohort]:='independent';END IF;END LOOP;
 END IF;
 FOR cohort IN 1..cohort_count LOOP
  CONTINUE WHEN dispatch[cohort]<>'graph';
  immutable:='[]';currents:='[]';denied:=false;
  FOR n IN SELECT x-'cohort' FROM jsonb_array_elements(membership) x WHERE (x->>'cohort')::integer=cohort LOOP
   IF n->>'kind'='application_query_domain' THEN CONTINUE;END IF;
   IF n->>'kind'='application_field' THEN
    source:=memo#>ARRAY['field:'||(n->>'id')||':'||(n->>'version'),'value'];
    IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN denied:=true;EXIT;END IF;
    SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(n->>'id')::uuid AND version=n->>'version';
    immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
   ELSE
    IF memo#>>ARRAY['native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),'value'] IS DISTINCT FROM 'true' THEN denied:=true;EXIT;END IF;
    source:=memo#>ARRAY['current',(n->>'kind')||':'||(n->>'id')||':'||(n->>'version')];
    IF source IS NULL OR source='null'::jsonb THEN CONTINUE;END IF;
    source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
     'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',n->'kind','resourceId',n->'id','version',source->'version');
    IF n->>'kind'='session_context_revision' THEN
     IF source->>'version' IS DISTINCT FROM n->>'version' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
     immutable:=immutable||jsonb_build_array(source);
    END IF;
   END IF;
   currents:=currents||jsonb_build_array(source-ARRAY['held','validTo','retractedAt']);
  END LOOP;
  results[cohort]:=CASE WHEN denied THEN jsonb_build_object('admitted',false)
   ELSE jsonb_build_object('admitted',true,'immutable',immutable,'current',currents) END;
 END LOOP;
 IF field_ids IS NOT NULL THEN
  FOR entry IN SELECT input.*,f.origin,f.type_key FROM unnest(field_ids,field_versions) WITH ORDINALITY input(id,version,position)
   LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=input.id ORDER BY input.position LOOP
   IF entry.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND entry.type_key IN('session_message','session_message_annotation') THEN
    snapshot:=coalesce(nullif(memo#>ARRAY['field:'||entry.id||':'||entry.version,'value'],'null'::jsonb),'{"held":true}'::jsonb);
   ELSE
    snapshot:=read_admitted_application_field_snapshot(w,entry.id,entry.version);
   END IF;
   snapshots:=snapshots||jsonb_build_array(jsonb_build_object('ord',entry.position,'snapshot',snapshot));
  END LOOP;
 END IF;
 IF authority IS NOT NULL THEN
  IF jsonb_typeof(authority) IS DISTINCT FROM 'array' OR jsonb_array_length(authority)<>9
   OR authority->>0 IS DISTINCT FROM w::text OR authority->>1 IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
  THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  authority_facts:=read_session_authority_facts((authority->>0)::uuid,(authority->>1)::uuid,(authority->>2)::uuid,(authority->>3)::uuid,
    (authority->>4)::uuid,(authority->>5)::integer,(authority->>6)::uuid,(authority->>7)::boolean,(authority->>8)::boolean);
 END IF;
 -- Closing fence, once per boundary. No row escapes before it.
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure) IS DISTINCT FROM guard_pin
  OR native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR policy_revision IS DISTINCT FROM (SELECT jsonb_build_array(c.revision,p.revision) FROM application_policy_contract_epoch c
   CROSS JOIN application_policy_workspace_epochs p WHERE c.singleton AND p.workspace_id=w)
  OR memo IS NOT NULL AND clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('cohorts',to_jsonb(results))
  ||CASE WHEN fields IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('fields',snapshots) END
  ||CASE WHEN authority IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('authority',authority_facts) END;
END $function$;
REVOKE ALL ON FUNCTION public.capture_conversation_preparation(uuid,jsonb,jsonb,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_conversation_preparation(uuid,jsonb,jsonb,jsonb) TO app_user;

-- Self-pin: the body carries the digest of its own complete catalog record
-- (with the digest literal replaced by zeros). Computed after the final ACL,
-- verified again after replacement; any later body or metadata drift refuses.
DO $preparation_self_pin$ DECLARE p pg_proc;digest text;definition text;placeholder constant text:=repeat('0',64);BEGIN
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.capture_conversation_preparation(uuid,jsonb,jsonb,jsonb)'::regprocedure;
 IF (length(p.prosrc)-length(replace(p.prosrc,placeholder,'')))/64<>1 THEN RAISE EXCEPTION 'preparation_self_pin_shape';END IF;
 digest:=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex');
 definition:=pg_get_functiondef(p.oid);
 IF (length(definition)-length(replace(definition,placeholder,'')))/64<>1 THEN RAISE EXCEPTION 'preparation_self_pin_shape';END IF;
 EXECUTE replace(definition,placeholder,digest);
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.capture_conversation_preparation(uuid,jsonb,jsonb,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(jsonb_set(to_jsonb(p),'{prosrc}',to_jsonb(replace(p.prosrc,digest,placeholder)))::text,'UTF8')),'hex')<>digest
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(p.proowner,p.proowner,'EXECUTE',false),makeaclitem((SELECT oid FROM pg_roles WHERE rolname='app_user'),p.proowner,'EXECUTE',false)]
 THEN RAISE EXCEPTION 'preparation_self_pin_mismatch';END IF;
END $preparation_self_pin$;
COMMIT;
