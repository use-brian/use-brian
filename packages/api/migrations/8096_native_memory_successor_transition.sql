BEGIN;
-- [COMP:api/application-persistence] Authenticated immutable Memory retirement.
-- Business payload stays on the canonical predecessor. This relation stores only
-- the atomic transition and its original operation, never a second record store.
CREATE TABLE native_memory_successor_transitions(
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 predecessor_id uuid PRIMARY KEY,predecessor_version text NOT NULL,
 successor_id uuid NOT NULL UNIQUE,actor_id uuid NOT NULL,assistant_id uuid NOT NULL,
 session_id uuid NOT NULL,context_fingerprint text NOT NULL CHECK(context_fingerprint ~ '^[a-f0-9]{64}$'),
 write_fields text[] NOT NULL,prior_updated_at timestamptz NOT NULL,
 transaction_id xid8 NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(predecessor_id<>successor_id),CHECK(cardinality(write_fields) BETWEEN 1 AND 4),
 CHECK(write_fields<@ARRAY['summary','detail','tags','confidence']::text[]),
 CHECK(array_position(write_fields,NULL) IS NULL)
);
ALTER TABLE native_memory_successor_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON native_memory_successor_transitions FROM PUBLIC;
CREATE TRIGGER native_memory_transition_immutable BEFORE UPDATE OR DELETE ON native_memory_successor_transitions
 FOR EACH ROW EXECUTE FUNCTION guard_application_field_metadata();

CREATE FUNCTION prepare_native_memory_successor(w uuid,i uuid,v text,fields text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;context jsonb;policy jsonb;mask jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF fields IS NULL OR cardinality(fields) NOT BETWEEN 1 AND 4 OR NOT fields<@ARRAY['summary','detail','tags','confidence']::text[]
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR v IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 context:=application_memory_query_context(w);
 source:=read_admitted_native_scope_snapshot(w,'memory',i);
 IF context IS NULL OR source IS NULL OR source->>'held' IS DISTINCT FROM 'false'
  OR source->>'version' IS DISTINCT FROM v OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL
  OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE
  OR member_operation_scope_allows(w,source->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(source->'compartments')),true) IS NOT TRUE
  OR agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'memory',i,v,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','memory',i::text);
 IF policy->>'registered'='false' THEN
  mask:=application_native_member_field_permissions(w,context->'policy',actor);
 ELSE
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','memory',i::text,v);
  mask:=jsonb_build_object('write',mask->'writeFields');
 END IF;
 IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'write'),false) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION prepare_native_memory_successor(uuid,uuid,text,text[]) FROM PUBLIC;

-- Private reuse of the current canonical lineage writer. The only authorship
-- difference is an exact active predecessor; this port is never app-callable.
DO $successor_lineage$
DECLARE definition text;before text;
BEGIN
 definition:=pg_get_functiondef('record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure);
 before:='record_admitted_application_field_derivation(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'record_admitted_memory_successor_derivation(');
 before:='sources jsonb)';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory lineage argument prerequisite changed';END IF;
 definition:=replace(definition,before,'sources jsonb, predecessor uuid, expected_version text)');
 before:='output.created_by_user_id IS DISTINCT FROM actor';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory lineage authorship prerequisite changed';END IF;
 definition:=replace(definition,before,$after$NOT EXISTS(SELECT 1 FROM memories old WHERE old.workspace_id=w AND old.id=predecessor
  AND old.scope_version::text=expected_version AND old.valid_to IS NULL AND NOT old.scope_held AND old.retracted_at IS NULL
  AND old.created_by_user_id IS NOT DISTINCT FROM output.created_by_user_id
  AND old.created_by_assistant_id IS NOT DISTINCT FROM output.created_by_assistant_id
  AND old.user_id IS NOT DISTINCT FROM output.user_id AND old.assistant_id IS NOT DISTINCT FROM output.assistant_id
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) input WHERE input->>'resourceKind'='memory'
   AND input->>'resourceId'=predecessor::text AND input->>'version'=expected_version))$after$);
 EXECUTE definition;
END $successor_lineage$;
REVOKE ALL ON FUNCTION record_admitted_memory_successor_derivation(uuid,text,uuid,text,text,jsonb,uuid,text) FROM PUBLIC;

CREATE FUNCTION retire_native_memory_successor(w uuid,i uuid,v text,n uuid,fields text[],acting uuid,session uuid,context_hash text,producer text,sources jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old memories;next memories;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 ignored text[]:=ARRAY['id','created_at','updated_at','valid_from','recall_count','useful_recall_count','last_recalled_at','query_hashes','recall_days',
  'consolidation_score','promoted_at','embedding','embedding_model_id','content_hash','embedding_failed_at','embedding_failure_reason','embedding_updated_at','search_vector',
  'centrality','centrality_computed_at','scope_version','sensitivity','compartments','project_ids'];
BEGIN
 PERFORM id FROM workspaces WHERE id=w FOR UPDATE;
 PERFORM prepare_native_memory_successor(w,i,v,fields);
 SELECT * INTO old FROM memories WHERE workspace_id=w AND id=i FOR UPDATE;
 IF NOT FOUND OR old.scope_version::text IS DISTINCT FROM v OR old.valid_to IS NOT NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 SELECT * INTO next FROM memories WHERE workspace_id=w AND id=n AND xmin::text::bigint=(pg_current_xact_id()::text::numeric % 4294967296)::bigint FOR UPDATE;
 IF NOT FOUND OR next.valid_to IS NOT NULL OR next.retracted_at IS NOT NULL OR next.scope_held
  OR (to_jsonb(next)-ignored-fields) IS DISTINCT FROM (to_jsonb(old)-ignored-fields)
  OR acting IS NULL OR acting::text IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')
  OR session IS NULL OR context_hash IS NULL OR context_hash !~ '^[a-f0-9]{64}$'
  OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=session AND s.workspace_id=w AND s.user_id=actor AND s.assistant_id=acting)
  OR sensitivity_rank(next.sensitivity)<sensitivity_rank(old.sensitivity)
  OR NOT old.compartments<@next.compartments OR NOT old.project_ids<@next.project_ids
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 INSERT INTO native_memory_successor_transitions(workspace_id,predecessor_id,predecessor_version,successor_id,actor_id,assistant_id,
  session_id,context_fingerprint,write_fields,prior_updated_at,transaction_id)
 VALUES(w,i,v,n,actor,acting,session,context_hash,fields,old.updated_at,pg_current_xact_id());
 PERFORM record_admitted_memory_successor_derivation(w,'memory',n,next.scope_version::text,producer,sources,i,v);
 UPDATE memories SET valid_to=now(),superseded_by=n,updated_at=now() WHERE workspace_id=w AND id=i AND scope_version::text=v AND valid_to IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='40001';END IF;
END $$;
REVOKE ALL ON FUNCTION retire_native_memory_successor(uuid,uuid,text,uuid,text[],uuid,uuid,text,text,jsonb) FROM PUBLIC;

-- The existing Memory trigger already keeps scope_version on pure retirement.
-- Only the canonical transition skips explicit descendant invalidation; ordinary
-- Memory updates and every other family's trigger remain unchanged.

-- This bounded metadata walk never calls successor ancestry. The ordinary
-- lineage walker still validates the predecessor's complete original inputs.
CREATE FUNCTION native_memory_successor_head(w uuid,i uuid,fields text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_id uuid:=i;source jsonb;row_value memories;transition native_memory_successor_transitions;policy jsonb;mask jsonb;context jsonb;steps integer:=0;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 context:=application_memory_query_context(w);IF context IS NULL THEN RETURN NULL;END IF;
 LOOP
  steps:=steps+1;IF steps>100 THEN RETURN NULL;END IF;
  SELECT * INTO row_value FROM memories WHERE workspace_id=w AND id=current_id;
  IF NOT FOUND OR row_value.scope_held OR row_value.retracted_at IS NOT NULL OR scope_review_state_held('memory',current_id) THEN RETURN NULL;END IF;
  source:=read_admitted_native_scope_snapshot(w,'memory',current_id);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE THEN RETURN NULL;END IF;
  policy:=CASE WHEN row_value.valid_to IS NULL THEN application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','memory',current_id::text)
   ELSE application_memory_historical_contract_for(w,'{"kind":"native","moduleKey":"native"}','memory',current_id::text) END;
  IF policy->>'registered'='false' THEN
   IF NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN NULL;END IF;
  ELSE
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
   mask:=application_native_member_field_permissions(w,policy,actor);
   IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'read'),false) THEN RETURN NULL;END IF;
  END IF;
  IF row_value.valid_to IS NULL THEN RETURN current_id;END IF;
  SELECT * INTO transition FROM native_memory_successor_transitions WHERE workspace_id=w AND predecessor_id=current_id
   AND predecessor_version=row_value.scope_version::text AND successor_id=row_value.superseded_by;
  IF NOT FOUND THEN RETURN NULL;END IF;
  current_id:=transition.successor_id;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION native_memory_successor_head(uuid,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION native_memory_historical_source(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM native_memory_successor_transitions t JOIN memories m ON m.workspace_id=t.workspace_id AND m.id=t.predecessor_id
  WHERE t.workspace_id=w AND t.predecessor_id=i AND m.scope_version::text=t.predecessor_version AND m.superseded_by=t.successor_id AND m.valid_to IS NOT NULL)
  OR native_memory_successor_head(w,i,fields) IS NULL THEN RETURN NULL;END IF;
 source:=read_admitted_native_scope_snapshot(w,'memory',i);
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
 RETURN source||jsonb_build_object('validTo',NULL);
END $$;
REVOKE ALL ON FUNCTION native_memory_historical_source(uuid,uuid,text[]) FROM PUBLIC;

-- Clone the existing validated deployed dictionary, changing only authentic
-- historical Memory retirement. Its catalog, roles and metadata checks stay.
DO $historical_contract$
DECLARE definition text;before text;
BEGIN
 definition:=pg_get_functiondef('application_native_field_contract_before_catalog(uuid,jsonb,text,text)'::regprocedure);
 before:='application_native_field_contract_before_catalog(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'application_memory_historical_contract_before_catalog(');
 before:='DECLARE canonical_origin';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'<<memory_history_contract>> DECLARE canonical_origin');
 before:=$before$OR source->>'validTo' IS NOT NULL$before$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Historical Memory dictionary prerequisite changed';END IF;
 definition:=replace(definition,before,$after$OR source->>'validTo' IS NOT NULL AND NOT (
  canonical_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND canonical_type='memory'
  AND EXISTS(SELECT 1 FROM native_memory_successor_transitions t JOIN memories m ON m.workspace_id=t.workspace_id AND m.id=t.predecessor_id
   WHERE t.workspace_id=w AND t.predecessor_id=p_id::uuid AND t.predecessor_version=memory_history_contract.source->>'version'
    AND m.scope_version::text=t.predecessor_version AND m.superseded_by=t.successor_id AND m.valid_to IS NOT NULL))$after$);
 EXECUTE definition;
 definition:=pg_get_functiondef('application_native_field_contract_for(uuid,jsonb,text,text)'::regprocedure);
 before:='application_native_field_contract_for(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'application_memory_historical_contract_for(');
 before:='application_native_field_contract_before_catalog(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'application_memory_historical_contract_before_catalog(');
 EXECUTE definition;
 definition:=pg_get_functiondef('read_native_application_field_mask(uuid,jsonb,text,text,text)'::regprocedure);
 before:='read_native_application_field_mask(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'read_native_memory_historical_field_mask(');
 before:='application_native_field_contract_for(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'application_memory_historical_contract_for(');
 EXECUTE definition;
END $historical_contract$;
REVOKE ALL ON FUNCTION application_memory_historical_contract_before_catalog(uuid,jsonb,text,text),application_memory_historical_contract_for(uuid,jsonb,text,text),
 read_native_memory_historical_field_mask(uuid,jsonb,text,text,text) FROM PUBLIC;

DO $historical_fields$
DECLARE definition text;before text;
BEGIN
 definition:=pg_get_functiondef('application_memory_field_state(uuid,uuid,text[])'::regprocedure);
 before:='application_memory_field_state(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'application_memory_historical_field_state(');
 before:='read_admitted_native_scope_snapshot(w,''memory'',i)';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'native_memory_historical_source(w,i,fields)');
 before:='application_native_field_contract_for(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'application_memory_historical_contract_for(');
 before:='read_native_application_field_mask(';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory clone prerequisite changed';END IF;
 definition:=replace(definition,before,'read_native_memory_historical_field_mask(');
 before:=$before$values_json:=values_json||jsonb_build_object(field,value);$before$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Historical Memory selected fields changed';END IF;
 definition:=replace(definition,before,$after$IF field IN('valid_to','superseded_by') THEN value:='null'::jsonb;
  ELSIF field='updated_at' THEN SELECT to_jsonb(t.prior_updated_at) INTO value FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND t.predecessor_id=i;END IF;
  values_json:=values_json||jsonb_build_object(field,value);$after$);
 EXECUTE definition;
END $historical_fields$;
REVOKE ALL ON FUNCTION application_memory_historical_field_state(uuid,uuid,text[]) FROM PUBLIC;
ALTER FUNCTION application_memory_field_state(uuid,uuid,text[]) RENAME TO application_memory_field_state_before_successor;
CREATE FUNCTION application_memory_field_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN application_memory_historical_field_state(w,i,fields);
 END IF;
 RETURN application_memory_field_state_before_successor(w,i,fields);
END $$;
REVOKE ALL ON FUNCTION application_memory_field_state(uuid,uuid,text[]),application_memory_field_state_before_successor(uuid,uuid,text[]) FROM PUBLIC;

ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_memory_successor;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF k='memory' AND EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN native_memory_historical_source(w,i,application_memory_field_keys());
 END IF;
 RETURN read_entity_derivation_source_before_memory_successor(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_entity_derivation_source(uuid,text,uuid),read_entity_derivation_source_before_memory_successor(uuid,text,uuid) FROM PUBLIC;

-- Historical field reevaluation does not turn a retired ID into a fresh point.
DO $live_point$
DECLARE definition text;before text;
BEGIN
 definition:=pg_get_functiondef('read_native_memory_point_projection(uuid,uuid,text)'::regprocedure);
 before:='SELECT scope_version::text INTO version FROM memories WHERE workspace_id=w AND id=i;';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory point prerequisite changed';END IF;
 EXECUTE replace(definition,before,'SELECT scope_version::text INTO version FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NULL AND retracted_at IS NULL;');
END $live_point$;

-- Fresh collection domains contain live candidates. Replay uses the original
-- cohort, subtracting only authenticated successor nodes of original candidates.
DO $fresh_query$
DECLARE definition text;before text;
BEGIN
 definition:=pg_get_functiondef('application_memory_query_scan(uuid,text[],jsonb,boolean)'::regprocedure);
 before:='FROM memories WHERE workspace_id=w ORDER BY id';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory query cohort prerequisite changed';END IF;
 EXECUTE replace(definition,before,'FROM memories WHERE workspace_id=w AND valid_to IS NULL ORDER BY id');
END $fresh_query$;
CREATE FUNCTION application_memory_historical_query_scan(w uuid,fields text[],bounds jsonb,include_retained boolean,frozen jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate record;state jsonb;count_value integer:=0;candidates jsonb:='[]';policies jsonb:='[]';excluded uuid[];
BEGIN
 IF fields IS NULL OR NOT fields<@application_memory_field_keys() OR application_query_scope_valid(bounds) IS NOT TRUE OR include_retained IS NULL THEN RETURN NULL;END IF;
 WITH RECURSIVE successors(id,depth) AS (
  SELECT t.successor_id,1 FROM native_memory_successor_transitions t JOIN jsonb_array_elements(frozen->'candidates') c ON t.predecessor_id=(c->>'id')::uuid
   WHERE t.workspace_id=w AND t.predecessor_version=c->>'version'
  UNION ALL SELECT t.successor_id,s.depth+1 FROM successors s JOIN native_memory_successor_transitions t ON t.workspace_id=w AND t.predecessor_id=s.id WHERE s.depth<100
 ) SELECT coalesce(array_agg(DISTINCT id),'{}') INTO excluded FROM successors;
 FOR candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w AND NOT id=ANY(excluded)
  AND (valid_to IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'candidates') c WHERE c->>'id'=memories.id::text AND c->>'version'=memories.scope_version::text)) ORDER BY id LOOP
  count_value:=count_value+1;IF count_value>4096 THEN RETURN NULL;END IF;
  IF NOT include_retained AND EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=candidate.id) THEN CONTINUE;END IF;
  state:=application_memory_field_state(w,candidate.id,fields);
  IF state IS NULL OR application_query_scope_admits_point(bounds,state->'source') IS NOT TRUE THEN CONTINUE;END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',candidate.scope_version::text,'source',state->'source'));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',state->'policyVersion'));
 END LOOP;
 RETURN jsonb_build_object('candidates',candidates,'policies',policies);
END $$;
REVOKE ALL ON FUNCTION application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb) FROM PUBLIC;
DO $query_replay$
DECLARE definition text;before text;
BEGIN
 definition:=pg_get_functiondef('application_memory_query_domain_state(uuid,uuid,text[])'::regprocedure);
 before:='application_memory_query_scan(w,fields,frozen.domain->''bounds'',(frozen.domain->>''includeRetained'')::boolean)';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory original domain prerequisite changed';END IF;
 EXECUTE replace(definition,before,'application_memory_historical_query_scan(w,fields,frozen.domain->''bounds'',(frozen.domain->>''includeRetained'')::boolean,frozen.domain)');
END $query_replay$;

-- Explicit history is a distinct observation; it exposes authentic retirement
-- metadata while old read/query observations continue to mean their old values.
CREATE FUNCTION application_memory_history_field_state(w uuid,i uuid,v text,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;row_value record;values_json jsonb;
BEGIN
 SELECT scope_version::text AS version,valid_to,superseded_by,updated_at INTO row_value FROM memories WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR row_value.version IS DISTINCT FROM v THEN RETURN NULL;END IF;
 state:=application_memory_field_state(w,i,fields);IF state IS NULL THEN RETURN NULL;END IF;
 values_json:=state->'values';
 IF 'valid_to'=ANY(fields) THEN values_json:=values_json||jsonb_build_object('valid_to',row_value.valid_to);END IF;
 IF 'superseded_by'=ANY(fields) THEN values_json:=values_json||jsonb_build_object('superseded_by',row_value.superseded_by);END IF;
 IF 'updated_at'=ANY(fields) THEN values_json:=values_json||jsonb_build_object('updated_at',row_value.updated_at);END IF;
 RETURN state||jsonb_build_object('values',values_json,'fieldIdentity',application_field_digest(jsonb_build_object('kind','memory-history-v1','fields',fields)));
END $$;
REVOKE ALL ON FUNCTION application_memory_history_field_state(uuid,uuid,text,text[]) FROM PUBLIC;
ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_memory_history;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='memory' AND p_selection='history' THEN
  RETURN application_memory_history_field_state(w,p_id,p_selected_version,p_fields);
 END IF;
 RETURN application_field_projection_state_before_memory_history(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]),application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION read_native_memory_history_projection(w uuid,i uuid,v text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fields text[];state jsonb;captured jsonb;
BEGIN
 fields:=ARRAY(SELECT field FROM unnest(application_memory_field_keys()) field ORDER BY field);
 state:=application_memory_history_field_state(w,i,v,fields);IF state IS NULL THEN RETURN NULL;END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','memory',i,v,'history',v,fields);
 IF captured IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('row',captured->'values','source',state->'source','sources',captured->'sources');
END $$;
REVOKE ALL ON FUNCTION read_native_memory_history_projection(uuid,uuid,text) FROM PUBLIC;

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON native_memory_successor_transitions FROM app_user;
 GRANT EXECUTE ON FUNCTION prepare_native_memory_successor(uuid,uuid,text,text[]),retire_native_memory_successor(uuid,uuid,text,uuid,text[],uuid,uuid,text,text,jsonb),read_entity_derivation_source(uuid,text,uuid),read_native_memory_history_projection(uuid,uuid,text) TO app_user;
END IF;END $$;
COMMIT;
