BEGIN;
-- [COMP:api/application-persistence] Memory selected fields and immutable native query domains.
-- Original source walk, same-destination and field-envelope functions are unchanged.
CREATE FUNCTION application_memory_field_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT ARRAY['id','assistant_id','user_id','app_id','workspace_id','scope','tags','summary','detail','confidence','sensitivity','compartments','project_ids','scope_version','scope_held','source','source_session_id','recall_count','useful_recall_count','last_recalled_at','created_at','updated_at','created_by_user_id','created_by_assistant_id','source_episode_id','verified_by_user_id','verified_at','valid_from','valid_to','superseded_by','retracted_at','retracted_reason','retracted_by','original_scope','original_sensitivity','original_summary']::text[]
$$;
REVOKE ALL ON FUNCTION application_memory_field_keys() FROM PUBLIC;

CREATE FUNCTION application_memory_query_context(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;bounds jsonb;policy jsonb;mask jsonb;keys text[];fields jsonb;scope jsonb;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.memories'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Unsupported in-flight data selectors hold instead of dropping a restriction.
 IF coalesce(nullif(current_setting('app.native_query_data_ceilings',true),'')::jsonb,'[]'::jsonb)<>'[]'::jsonb THEN RETURN NULL;END IF;
 bounds:=application_native_query_bounds(w);IF bounds IS NULL OR application_query_scope_valid(bounds) IS NOT TRUE THEN RETURN NULL;END IF;
 keys:=ARRAY(SELECT key FROM unnest(application_memory_field_keys()) key ORDER BY key);
 policy:=application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','memory');
 IF policy->>'registered'='false' THEN
  SELECT jsonb_agg(jsonb_build_object('key',key,'read','[]'::jsonb,'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key)
   INTO fields FROM unnest(keys) key;
  -- This is the public schema definition, not a default for a data row or missing ancestor.
  scope:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb);
  policy:=jsonb_build_object('registered',true,'held',false,'nativeDefault',true,'roleKeys','[]'::jsonb,
   'metadata',jsonb_build_object('moduleKey','native','origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey','memory',
    'schemaVersion','memory-fields-v1','policyVersion','memory-fields-v1','fieldKeys',keys,'fields',fields,'scope',scope),
   'fingerprint',application_field_digest(jsonb_build_object('kind','memory-fields-v1','workspaceId',w,'fields',fields)));
  mask:=application_native_member_field_permissions(w,policy,actor);
 ELSE
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR NOT coalesce(to_jsonb(keys)<@(policy#>'{metadata,fieldKeys}'),false) THEN RETURN NULL;END IF;
  mask:=read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','memory');
  mask:=jsonb_build_object('read',mask->'readFields');
 END IF;
 IF workflow_evidence_envelope_visible(w,policy#>'{metadata,scope}') IS NOT TRUE OR jsonb_typeof(mask->'read') IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('policy',policy,'read',mask->'read','bounds',bounds,
  'visibility',jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
   'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_memory_query_context(uuid) FROM PUBLIC;

CREATE FUNCTION application_memory_field_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;source jsonb;policy jsonb;mask jsonb;row_version text;values_json jsonb:='{}';field text;value jsonb;
BEGIN
 IF fields IS NULL OR NOT fields<@application_memory_field_keys() OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f) THEN RETURN NULL;END IF;
 context:=application_memory_query_context(w);
 IF context IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN NULL;END IF;
 SELECT scope_version::text INTO row_version FROM memories WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- Retained history without matching immutable current observations never becomes a native leaf.
 IF EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=i)
  AND NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=i AND d.resource_version=row_version) THEN RETURN NULL;END IF;
 source:=read_admitted_native_scope_snapshot(w,'memory',i);
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM row_version
  OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'memory',i,row_version) IS NOT TRUE THEN RETURN NULL;END IF;
 policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','memory',i::text);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR policy#>>'{metadata,recordVersion}' IS DISTINCT FROM row_version THEN RETURN NULL;END IF;
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','memory',i::text,row_version);
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'readFields'),false) THEN RETURN NULL;END IF;
 END IF;
 -- Only the selected, already admitted fields are evaluated. No whole-row JSON before the mask.
 FOREACH field IN ARRAY fields LOOP
  EXECUTE format('SELECT to_jsonb(%I) FROM public.memories WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3',
   field)
   INTO value USING w,i,row_version;
  values_json:=values_json||jsonb_build_object(field,value);
 END LOOP;
 source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId',
  'sensitivity',source->'sensitivity','compartments',source->'compartments','projectIds',source->'projectIds',
  'resourceKind','memory','resourceId',i,'version',row_version);
 RETURN jsonb_build_object('values',values_json,'source',source,'recordVersion',row_version,'sourceKind','memory','sourceId',i,'sourceVersion',row_version,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','memory-fields-v1','fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','memory-fields-v1','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','mask',mask)),
  'references','[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION application_memory_field_state(uuid,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_memory_query_scan(w uuid,fields text[],bounds jsonb,include_retained boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate record;state jsonb;count_value integer:=0;candidates jsonb:='[]';policies jsonb:='[]';
BEGIN
 IF fields IS NULL OR NOT fields<@application_memory_field_keys() OR application_query_scope_valid(bounds) IS NOT TRUE OR include_retained IS NULL THEN RETURN NULL;END IF;
 FOR candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w ORDER BY id LOOP
  count_value:=count_value+1;IF count_value>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  IF NOT include_retained AND EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=candidate.id) THEN CONTINUE;END IF;
  state:=application_memory_field_state(w,candidate.id,fields);
  IF state IS NULL OR application_query_scope_admits_point(bounds,state->'source') IS NOT TRUE THEN CONTINUE;END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',candidate.scope_version::text,'source',state->'source'));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',state->'policyVersion'));
 END LOOP;
 RETURN jsonb_build_object('candidates',candidates,'policies',policies);
END $$;
REVOKE ALL ON FUNCTION application_memory_query_scan(uuid,text[],jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION application_memory_query_domain_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;context jsonb;scanned jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='memory';
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'memory_query_domain_v1'
  OR frozen.domain-ARRAY['kind','fields','bounds','visibility','includeRetained','candidates','policies']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN NULL;END IF;
 context:=application_memory_query_context(w);
 IF context IS NULL OR context#>>'{policy,metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version
  OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false)
  OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(context->'bounds'),4096)->>'contains' IS DISTINCT FROM 'true'
  OR frozen.domain->'visibility' IS DISTINCT FROM context->'visibility' THEN RETURN NULL;END IF;
 scanned:=application_memory_query_scan(w,fields,frozen.domain->'bounds',(frozen.domain->>'includeRetained')::boolean);
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates' OR scanned->'policies' IS DISTINCT FROM frozen.domain->'policies' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',context#>'{policy,metadata,scope}','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','memory_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','memory_query_domain_v1','identity',frozen.identity,'policy',context#>'{policy,fingerprint}','policies',scanned->'policies')),
  'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_memory_query_domain_state(uuid,uuid,text[]) FROM PUBLIC;

ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_memory_query;
REVOKE ALL ON FUNCTION application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='memory' THEN
  IF p_selected_version IS NOT NULL THEN RETURN NULL;END IF;
  IF p_selection='query_domain' THEN RETURN application_memory_query_domain_state(w,p_id,p_fields);END IF;
  IF p_selection NOT IN('read','query','identity') THEN RETURN NULL;END IF;
  RETURN application_memory_field_state(w,p_id,p_fields);
 END IF;
 RETURN application_field_projection_state_before_memory_query(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

CREATE FUNCTION read_native_memory_query_projection(w uuid,fields text[],include_retained boolean) RETURNS TABLE(value jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;scanned jsonb;domain jsonb;identity_value text;domain_id uuid;frozen application_query_domains;captured jsonb;point jsonb;state jsonb;
BEGIN
 IF fields IS NULL OR cardinality(fields)>cardinality(application_memory_field_keys()) OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f) THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 fields:=ARRAY(SELECT f FROM unnest(fields) f ORDER BY f);
 context:=application_memory_query_context(w);
 IF context IS NULL OR fields IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 scanned:=application_memory_query_scan(w,fields,context->'bounds',include_retained);
 IF scanned IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 domain:=jsonb_build_object('kind','memory_query_domain_v1','fields',fields,'bounds',context->'bounds','visibility',context->'visibility',
  'includeRetained',include_retained,'candidates',scanned->'candidates','policies',scanned->'policies');
 identity_value:=application_field_digest(jsonb_build_object('kind','memory_query_domain_v1','workspaceId',w,'domain',domain));domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity) VALUES(domain_id,w,'{"kind":"native","moduleKey":"native"}','memory',
  context#>>'{policy,metadata,schemaVersion}',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=domain_id;
 IF NOT FOUND OR (frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM ('memory',context#>>'{policy,metadata,schemaVersion}',domain,identity_value) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','memory',domain_id,frozen.schema_version,'query_domain',NULL,fields);
 IF captured IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 value:=jsonb_build_object('row',NULL,'sources',captured->'sources');RETURN NEXT;
 FOR point IN SELECT item FROM jsonb_array_elements(scanned->'candidates') item LOOP
  captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','memory',(point->>'id')::uuid,point->>'version','query',NULL,fields);
  IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  value:=jsonb_build_object('row',captured->'values','source',point->'source','sources',captured->'sources');RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_memory_query_projection(uuid,text[],boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_native_memory_query_projection(uuid,text[],boolean) TO app_user;
END IF;END $$;

CREATE FUNCTION read_native_memory_point_projection(w uuid,i uuid,expected_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE version text;fields text[];state jsonb;captured jsonb;
BEGIN
 IF expected_version IS NULL THEN RETURN NULL;END IF;
 SELECT scope_version::text INTO version FROM memories WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR version IS DISTINCT FROM expected_version THEN RETURN NULL;END IF;
 fields:=ARRAY(SELECT field FROM unnest(application_memory_field_keys()) field ORDER BY field);
 state:=application_memory_field_state(w,i,fields);
 IF state IS NULL OR state->>'recordVersion' IS DISTINCT FROM expected_version THEN RETURN NULL;END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','memory',i,expected_version,'read',NULL,fields);
 IF captured IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('row',captured->'values','source',state->'source','sources',captured->'sources');
END $$;
REVOKE ALL ON FUNCTION read_native_memory_point_projection(uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_native_memory_point_projection(uuid,uuid,text) TO app_user;
END IF;END $$;

-- Host-only discovery returns envelope/version metadata, never payload or authority.
CREATE FUNCTION read_native_memory_query_metadata(w uuid) RETURNS TABLE(source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate record;attempts integer:=0;
BEGIN
 IF application_memory_query_context(w) IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 FOR candidate IN SELECT id,scope_version,user_id,assistant_id,sensitivity,compartments,project_ids FROM memories WHERE workspace_id=w ORDER BY id LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  source:=jsonb_build_object('workspaceId',w,'userId',candidate.user_id,'assistantId',candidate.assistant_id,'sensitivity',candidate.sensitivity,
   'compartments',candidate.compartments,'projectIds',candidate.project_ids,'resourceKind','memory','resourceId',candidate.id,'version',candidate.scope_version::text);RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_memory_query_metadata(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_native_memory_query_metadata(uuid) TO app_user;
END IF;END $$;

-- Private metadata discovery includes newly eligible and formerly source-denied candidates.
-- It grants no row/field/source authority and never reads Memory business values.
CREATE FUNCTION read_native_memory_query_cohort_sources(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS TABLE(source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb;selector record;candidate record;root jsonb;attempts integer:=0;
BEGIN
 SELECT coalesce(jsonb_agg(to_jsonb(n)),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 FOR selector IN SELECT DISTINCT q.domain FROM jsonb_to_recordset(nodes) n(kind text,id uuid,version text)
  JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id AND n.kind='application_field'
  JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=n.version
  JOIN application_query_domains q ON q.workspace_id=w AND q.id=f.resource_id AND q.type_key=f.type_key AND q.origin=f.origin
  WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain' LOOP
  IF selector.domain->>'kind' IS DISTINCT FROM 'memory_query_domain_v1' OR application_query_scope_valid(selector.domain->'bounds') IS NOT TRUE THEN
   RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
  IF selector.domain->>'includeRetained' IS DISTINCT FROM 'true' THEN CONTINUE;END IF;
  FOR candidate IN SELECT id FROM memories WHERE workspace_id=w ORDER BY id LOOP
   attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   root:=read_scope_source(w,'memory',candidate.id);
   IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' OR application_query_scope_admits_point(selector.domain->'bounds',root) IS NOT TRUE THEN CONTINUE;END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',root->'userId','assistantId',root->'assistantId','sensitivity',root->'sensitivity',
    'compartments',root->'compartments','projectIds',root->'projectIds','resourceKind','memory','resourceId',candidate.id,'version',root->'version');RETURN NEXT;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[]) FROM PUBLIC;
-- Explicit release is current source authority, not a live-governed requirement.
-- Preserve function owner/ACL/search path and every unrelated kernel fingerprint.
DO $released_field_capture$
DECLARE definition text;before text;after text;old_hash text:='8f7f28732bfddafd57fea2e215075ae8d75ba9097433536800a74bc99f2b6860';new_hash text;
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure) IS DISTINCT FROM old_hash
  THEN RAISE EXCEPTION 'Field observer prerequisite changed';END IF;
 definition:=pg_get_functiondef('public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure);
 before:=$old$o.observation#>>'{retention,mode}'='governed'$old$;
 after:=$new$(o.observation#>>'{retention,mode}'='governed' OR
  o.observation#>>'{retention,mode}'='released_snapshot'
  AND length(o.observation#>>'{retention,releaseId}')>0
  AND jsonb_typeof(o.observation#>'{retention,expiresAt}')='number'
  AND (o.observation#>>'{retention,expiresAt}')::numeric>extract(epoch FROM clock_timestamp())*1000)$new$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Field observer source mode guard changed';END IF;
 EXECUTE replace(definition,before,after);
 SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_hash FROM pg_proc
  WHERE oid='public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure;
 definition:=pg_get_functiondef('public.capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure);
 IF array_length(string_to_array(definition,old_hash),1)<>3 THEN RAISE EXCEPTION 'Session observer fingerprint contract changed';END IF;
 definition:=replace(definition,old_hash,new_hash);
 before:=$old$observation.observation#>>'{retention,mode}'='governed'$old$;
 after:=$new$(observation.observation#>>'{retention,mode}'='governed' OR
  observation.observation#>>'{retention,mode}'='released_snapshot'
  AND length(observation.observation#>>'{retention,releaseId}')>0
  AND jsonb_typeof(observation.observation#>'{retention,expiresAt}')='number'
  AND (observation.observation#>>'{retention,expiresAt}')::numeric>extract(epoch FROM clock_timestamp())*1000)$new$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Session source mode guard changed';END IF;
 EXECUTE replace(definition,before,after);
END $released_field_capture$;
COMMIT;
