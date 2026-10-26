BEGIN;
-- [COMP:security/native-field-policy] Ordinary generic metadata is independent
-- of native module ownership; candidate scope always comes from the real reader.
CREATE FUNCTION application_query_scope_admits_point(bounds jsonb,source jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope jsonb:=public.application_normalize_native_query_bounds(bounds); rank int:=public.sensitivity_rank(source->>'sensitivity');
 teams text[]; labels jsonb; others jsonb; team text;
BEGIN
 IF public.application_query_scope_valid(bounds) IS NOT TRUE OR rank IS NULL OR rank NOT BETWEEN 1 AND 3
  OR jsonb_typeof(source->'compartments') IS DISTINCT FROM 'array' OR jsonb_typeof(source->'projectIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 SELECT coalesce(array_agg(DISTINCT substr(value#>>'{}',6)),'{}') INTO teams
  FROM jsonb_array_elements(source->'compartments') WHERE value#>>'{}' LIKE 'team:%';
 IF cardinality(teams)=0 THEN
  IF rank>(scope->>'tier')::int THEN RETURN false; END IF;
 ELSE
  IF scope->>'contextDepartment' IS NOT NULL AND NOT (scope->>'contextDepartment'=ANY(teams)) THEN RETURN false; END IF;
  FOREACH team IN ARRAY teams LOOP
   IF rank>(CASE WHEN scope->'departments'='null' THEN (scope->>'tier')::int ELSE coalesce((scope#>>ARRAY['departments',team])::int,0) END) THEN RETURN false; END IF;
  END LOOP;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(substr(value#>>'{}',9))),'[]') INTO labels
  FROM jsonb_array_elements(source->'compartments') WHERE value#>>'{}' LIKE 'project:%';
 SELECT coalesce(jsonb_agg(value),'[]') INTO others FROM jsonb_array_elements(source->'compartments')
  WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%';
 RETURN coalesce(labels<@(scope->'projectLabels') AND (scope->'otherLabels'='null' OR others<@(scope->'otherLabels'))
  AND (scope->'projectIds'='null' OR source->'projectIds'<@(scope->'projectIds')),false);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_query_scope_admits_point(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_selector_query_domain_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_fields text[],frozen public.application_query_domains) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admitted jsonb; policy jsonb; current_domain jsonb; bounds jsonb; mask jsonb;
 properties jsonb; anchor_refs jsonb:='[]'; relationship jsonb; reference jsonb; required text[];
BEGIN
 IF frozen.domain->>'kind' IS DISTINCT FROM 'application_selector_domain' THEN RETURN NULL; END IF;
 IF p_origin->>'kind' IS DISTINCT FROM 'generic' OR p_fields IS NULL OR cardinality(p_fields)>128 OR array_position(p_fields,NULL) IS NOT NULL
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field)
  OR frozen.domain->'version' IS DISTINCT FROM '1'::jsonb
  OR frozen.domain-ARRAY['kind','version','formula','requiredFields']<>'{}'::jsonb
  OR jsonb_typeof(frozen.domain->'requiredFields') IS DISTINCT FROM 'array'
  OR jsonb_array_length(frozen.domain->'requiredFields')>128
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(frozen.domain->'requiredFields') field WHERE jsonb_typeof(field)<>'string') THEN RETURN NULL; END IF;
 required:=ARRAY(SELECT jsonb_array_elements_text(frozen.domain->'requiredFields'));
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  admitted:=public.application_current_query_catalog_for_origin(w,p_origin);
  IF admitted IS NULL OR NOT to_jsonb(p_fields)<@(admitted->'read') THEN RETURN NULL; END IF;
  policy:=admitted->'policy';current_domain:=public.application_compile_query_catalog_domain(w,admitted);
 ELSE
  bounds:=public.application_native_query_bounds(w);
  IF bounds IS NULL THEN RETURN NULL; END IF;
  policy:=public.application_generic_query_catalog_policy(w,p_origin,p_type);
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
  IF policy->>'genericDefault'='true' THEN
   mask:=public.application_native_member_field_permissions(w,policy,nullif(current_setting('app.current_user_id',true),'')::uuid);
  ELSE
   mask:=public.read_native_application_field_catalog(w,p_origin,p_type);
   mask:=jsonb_build_object('read',mask->'readFields');
  END IF;
  IF mask IS NULL OR NOT coalesce(to_jsonb(p_fields)<@(mask->'read'),false)
   OR public.workflow_evidence_envelope_visible(w,policy#>'{metadata,scope}') IS NOT TRUE THEN RETURN NULL; END IF;
  current_domain:=jsonb_build_object('kind','application_query','version',1,'clauses',jsonb_build_array(
   jsonb_build_object('scope',bounds,'read',mask->'read','selector',jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships','[]'::jsonb,'empty',false))));
 END IF;
 IF policy#>>'{metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version
  OR public.application_query_domain_contains(current_domain,frozen.domain->'formula',required) IS NOT TRUE THEN RETURN NULL; END IF;
 FOR relationship IN SELECT DISTINCT relation FROM jsonb_array_elements(frozen.domain#>'{formula,clauses}') clause,
  LATERAL jsonb_array_elements(clause#>'{selector,relationships}') relation LOOP
  reference:=public.application_query_anchor_reference(w,p_origin,relationship->>'resolverKey',relationship->>'anchorId');
  IF reference IS NULL THEN RETURN NULL; END IF;
  anchor_refs:=anchor_refs||jsonb_build_array(reference);
  IF jsonb_array_length(anchor_refs)>256 THEN RETURN NULL; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(p ORDER BY p->>'name'),'[]') INTO properties FROM public.entity_types t,LATERAL jsonb_array_elements(t.properties) p
  WHERE t.workspace_id=w AND t.id=(p_origin->>'entityTypeId')::uuid AND p->>'name'=ANY(p_fields);
 IF jsonb_array_length(properties)<>cardinality(p_fields) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',policy#>'{metadata,scope}','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',p_id,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',public.application_field_digest(jsonb_build_object('domain',frozen.identity,'properties',properties)),
  'policyVersion',public.application_field_digest(jsonb_build_object('domain',frozen.identity,'catalog',policy->'fingerprint','properties',properties)),
  'references',anchor_refs);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_selector_query_domain_state(uuid,jsonb,text,uuid,text[],public.application_query_domains) FROM PUBLIC;

ALTER FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) RENAME TO application_query_domain_state_before_points;
REVOKE ALL ON FUNCTION application_query_domain_state_before_points(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_query_domain_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen public.application_query_domains; original public.application_query_domains; state jsonb;
BEGIN
 SELECT * INTO frozen FROM public.application_query_domains d WHERE d.workspace_id=w AND d.id=p_id AND d.origin=p_origin AND d.type_key=p_type;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF frozen.domain->>'kind' IS DISTINCT FROM 'application_query_points' THEN
  RETURN public.application_query_domain_state_before_points(w,p_origin,p_type,p_id,p_fields);
 END IF;
 IF frozen.domain->'version' IS DISTINCT FROM '1'::jsonb
  OR frozen.domain-ARRAY['kind','version','remaining','queryPoints','checkedIds','candidates']<>'{}'::jsonb
  OR NOT frozen.domain ?& ARRAY['kind','version','remaining','queryPoints','checkedIds','candidates']
  OR jsonb_typeof(frozen.domain->'queryPoints') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen.domain->'queryPoints')>4096
  OR jsonb_typeof(frozen.domain->'checkedIds') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen.domain->'checkedIds')>4096
  OR jsonb_typeof(frozen.domain->'candidates') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen.domain->'candidates')>4096 THEN RETURN NULL; END IF;
 original:=frozen;original.domain:=frozen.domain->'remaining';
 state:=public.application_selector_query_domain_state(w,p_origin,p_type,p_id,p_fields,original);
 IF state IS NULL THEN RETURN NULL; END IF;
 RETURN state||jsonb_build_object('queryPoints',frozen.domain->'queryPoints');
END $$;
REVOKE ALL ON FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;

-- Query points remain query selections. Identity/read references are unchanged.
ALTER FUNCTION application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer) RENAME TO application_compute_field_envelope_before_query_points;
REVOKE ALL ON FUNCTION application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer) FROM PUBLIC;
CREATE FUNCTION application_compute_field_envelope(w uuid,p_origin jsonb,p_type text,p_id uuid,
 p_selection text,p_selected_version text,p_fields text[],depth integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE envelope jsonb; point jsonb; child jsonb; children jsonb; sources jsonb; scope jsonb; version_value text;
BEGIN
 envelope:=public.application_compute_field_envelope_before_query_points(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields,depth);
 IF envelope IS NULL OR envelope#>'{state,queryPoints}' IS NULL THEN RETURN envelope; END IF;
 IF depth NOT BETWEEN 0 AND 1 OR p_selection IS DISTINCT FROM 'query_domain' THEN RETURN NULL; END IF;
 children:=envelope->'children';sources:=envelope->'sources';
 FOR point IN SELECT value FROM jsonb_array_elements(envelope#>'{state,queryPoints}') LOOP
  IF jsonb_typeof(point) IS DISTINCT FROM 'object' OR NOT point ?& ARRAY['id','version','fields','source']
   OR point-ARRAY['id','version','fields','source']<>'{}'::jsonb OR jsonb_typeof(point->'fields') IS DISTINCT FROM 'array'
   OR jsonb_array_length(point->'fields')>128 OR point#>>'{source,workspaceId}' IS DISTINCT FROM w::text THEN RETURN NULL; END IF;
  child:=public.application_compute_field_envelope(w,p_origin,p_type,(point->>'id')::uuid,'query',NULL,
   ARRAY(SELECT jsonb_array_elements_text(point->'fields')),depth+1);
  IF child IS NULL OR child#>>'{state,recordVersion}' IS DISTINCT FROM point->>'version' OR child->'source' IS DISTINCT FROM point->'source' THEN RETURN NULL; END IF;
  children:=children||jsonb_build_array(child);sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]'::jsonb);
  IF jsonb_array_length(sources)>4096 OR jsonb_array_length(children)>4096 THEN RETURN NULL; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;
 scope:=(envelope->'source')-ARRAY['resourceKind','resourceId','version'];
 version_value:=public.application_field_digest(jsonb_build_object('resourceId',envelope->'resourceId','recordVersion',envelope#>'{state,recordVersion}',
  'sourceVersion',envelope#>'{state,sourceVersion}','policyVersion',envelope#>'{state,policyVersion}','scope',scope,'sources',sources));
 RETURN envelope||jsonb_build_object('children',children,'sources',sources,'source',(envelope->'source')||jsonb_build_object('version',version_value));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer) FROM PUBLIC;

CREATE FUNCTION application_refine_query_points(w uuid,p_type uuid,p_alias text,formula jsonb,required_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type); clause jsonb; identity_value jsonb;
 id_text text; canonical_id uuid; version_value text; child jsonb; retained_ids jsonb; clauses jsonb:='[]';
 points jsonb:='[]'; checked_ids jsonb:='[]'; candidates jsonb:='[]'; attempts int:=0;
BEGIN
 IF public.application_query_domain_contains(formula,formula,'{}') IS NOT TRUE THEN RETURN NULL; END IF;
 FOR clause IN SELECT value FROM jsonb_array_elements(formula->'clauses') LOOP
  IF clause#>'{selector,ids}'='null' OR clause#>>'{selector,ownerId}' IS NOT NULL
   OR clause#>'{selector,relationships}'<>'[]'::jsonb THEN clauses:=clauses||jsonb_build_array(clause);CONTINUE; END IF;
  retained_ids:=clause#>'{selector,ids}';
  FOR identity_value IN SELECT value FROM jsonb_array_elements(clause#>'{selector,ids}') LOOP
   attempts:=attempts+1;
   IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
   id_text:=identity_value#>>'{}';
   IF id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    checked_ids:=checked_ids||jsonb_build_array(id_text);CONTINUE;
   END IF;
   canonical_id:=id_text::uuid;checked_ids:=checked_ids||jsonb_build_array(canonical_id);
   SELECT projected.record_version::text INTO version_value FROM public.application_generic_projection(p_type,p_alias,'query',canonical_id) projected;
   IF NOT FOUND THEN CONTINUE; END IF;
   candidates:=candidates||jsonb_build_array(jsonb_build_object('id',canonical_id,'version',version_value));
   child:=public.application_compute_field_envelope(w,origin,'record.'||p_type,canonical_id,'query',NULL,required_fields,1);
   IF child IS NULL THEN CONTINUE; END IF;
   IF child#>>'{state,recordVersion}' IS DISTINCT FROM version_value THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
   IF public.application_query_scope_admits_point(clause->'scope',child->'source') IS NOT TRUE THEN CONTINUE; END IF;
   points:=points||jsonb_build_array(jsonb_build_object('id',canonical_id,'version',version_value,'fields',required_fields,'source',child->'source'));
   SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO retained_ids FROM jsonb_array_elements(retained_ids) WHERE value<>identity_value;
  END LOOP;
  IF jsonb_array_length(retained_ids)>0 THEN clauses:=clauses||jsonb_build_array(jsonb_set(clause,'{selector,ids}',retained_ids)); END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO points FROM (SELECT DISTINCT value FROM jsonb_array_elements(points)) unique_points;
 SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO checked_ids FROM (SELECT DISTINCT value FROM jsonb_array_elements(checked_ids)) unique_ids;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]') INTO candidates FROM (SELECT DISTINCT value FROM jsonb_array_elements(candidates)) unique_candidates;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) candidate GROUP BY candidate->>'id' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('formula',formula||jsonb_build_object('clauses',clauses),'queryPoints',points,'checkedIds',checked_ids,'candidates',candidates);
END $$;
REVOKE ALL ON FUNCTION application_refine_query_points(uuid,uuid,text,jsonb,text[]) FROM PUBLIC;

CREATE FUNCTION observe_application_query_points(w uuid,p_type uuid,p_alias text,p_fields text[],p_required_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type); canonical_type text:='record.'||p_type;
 admitted jsonb; formula jsonb; refined jsonb; domain jsonb; identity_value text; domain_id uuid;
 envelope jsonb; frozen public.application_query_domains; required text[];
BEGIN
 IF p_fields IS NULL OR p_required_fields IS NULL OR cardinality(p_fields)>128 OR cardinality(p_required_fields)>128
  OR array_position(p_fields,NULL) IS NOT NULL OR array_position(p_required_fields,NULL) IS NOT NULL
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field)
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_required_fields) field)
  OR NOT p_required_fields<@p_fields THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 admitted:=public.application_current_query_catalog(w,origin,p_alias);
 IF admitted IS NULL OR NOT to_jsonb(p_fields)<@(admitted->'read') THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 formula:=public.application_compile_query_catalog_domain(w,admitted);
 required:=ARRAY(SELECT field FROM unnest(p_required_fields) field ORDER BY field);
 refined:=public.application_refine_query_points(w,p_type,p_alias,formula,required);
 IF refined IS NULL OR public.application_query_domain_contains(formula,refined->'formula',required) IS NOT TRUE THEN
  RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 domain:=jsonb_build_object('kind','application_query_points','version',1,
  'remaining',jsonb_build_object('kind','application_selector_domain','version',1,'formula',refined->'formula','requiredFields',required),
  'queryPoints',refined->'queryPoints','checkedIds',refined->'checkedIds','candidates',refined->'candidates');
 identity_value:=public.application_field_digest(jsonb_build_object('kind','application_query_points','workspaceId',w,'origin',origin,
  'schemaVersion',admitted#>'{policy,metadata,schemaVersion}','domain',domain));
 domain_id:=public.application_field_resource_uuid(identity_value);
 INSERT INTO public.application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,origin,canonical_type,admitted#>>'{policy,metadata,schemaVersion}',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM public.application_query_domains d WHERE d.workspace_id=w AND d.id=domain_id;
 IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity)
  IS DISTINCT FROM (origin,canonical_type,admitted#>>'{policy,metadata,schemaVersion}',domain,identity_value) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
 envelope:=public.application_compute_field_envelope(w,origin,canonical_type,domain_id,'query_domain',NULL,p_fields);
 IF envelope IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM public.application_materialize_field_envelope(w,envelope);
 RETURN jsonb_build_object('values','{}'::jsonb,'sources',jsonb_build_array(envelope->'source')||coalesce(envelope->'sources','[]'::jsonb),
  'policyVersion',envelope#>'{state,policyVersion}');
END $$;
REVOKE ALL ON FUNCTION observe_application_query_points(uuid,uuid,text,text[],text[]) FROM PUBLIC;

CREATE FUNCTION assert_generic_application_query_candidates(w uuid,p_type uuid,source_id uuid,source_version text,candidates jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen public.application_query_domains; snapshot jsonb; actual jsonb;
BEGIN
 IF jsonb_typeof(candidates) IS DISTINCT FROM 'array' OR jsonb_array_length(candidates)>4096
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) candidate WHERE jsonb_typeof(candidate) IS DISTINCT FROM 'object'
   OR NOT candidate ?& ARRAY['id','version'] OR candidate-ARRAY['id','version']<>'{}'::jsonb
   OR jsonb_typeof(candidate->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(candidate->'version') IS DISTINCT FROM 'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) candidate GROUP BY candidate->>'id' HAVING count(*)>1) THEN RETURN false; END IF;
 snapshot:=public.read_admitted_application_field_snapshot(w,source_id,source_version);
 IF snapshot->>'held' IS DISTINCT FROM 'false' THEN RETURN false; END IF;
 SELECT d.* INTO frozen FROM public.application_field_resources field JOIN public.application_query_domains d ON d.id=field.resource_id
  WHERE field.id=source_id AND field.workspace_id=w AND field.selection='query_domain'
   AND d.workspace_id=w AND d.origin=jsonb_build_object('kind','generic','entityTypeId',p_type);
 IF NOT FOUND THEN RETURN false; END IF;
 IF frozen.domain->>'kind' IS DISTINCT FROM 'application_query_points' THEN RETURN true; END IF;
 SELECT coalesce(jsonb_agg(candidate ORDER BY candidate->>'id'),'[]') INTO actual FROM jsonb_array_elements(candidates) candidate
  WHERE (frozen.domain->'checkedIds') ? (candidate->>'id');
 RETURN actual IS NOT DISTINCT FROM frozen.domain->'candidates';
END $$;
REVOKE ALL ON FUNCTION assert_generic_application_query_candidates(uuid,uuid,uuid,text,jsonb) FROM PUBLIC;

ALTER FUNCTION observe_generic_application_query_domain(uuid,uuid,text,text[],text[]) RENAME TO observe_generic_application_query_domain_before_points;
REVOKE ALL ON FUNCTION observe_generic_application_query_domain_before_points(uuid,uuid,text,text[],text[]) FROM PUBLIC;
CREATE FUNCTION observe_generic_application_query_domain(w uuid,p_type uuid,p_alias text,p_fields text[],p_required_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type); canonical_type text:='record.'||p_type;
 policy jsonb; bounds jsonb; mask jsonb; formula jsonb; domain jsonb; identity_value text; domain_id uuid;
 envelope jsonb; frozen public.application_query_domains;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  RETURN public.observe_application_query_points(w,p_type,p_alias,p_fields,p_required_fields);
 END IF;
 policy:=public.application_generic_query_catalog_policy(w,origin,canonical_type);
 IF policy->>'genericDefault' IS DISTINCT FROM 'true' THEN
  RETURN public.observe_generic_application_query_domain_before_points(w,p_type,p_alias,p_fields,p_required_fields);
 END IF;
 bounds:=public.application_native_query_bounds(w);
 mask:=public.application_native_member_field_permissions(w,policy,nullif(current_setting('app.current_user_id',true),'')::uuid);
 IF bounds IS NULL OR mask IS NULL OR p_fields IS NULL OR p_required_fields IS NULL
  OR cardinality(p_fields)>128 OR cardinality(p_required_fields)>128
  OR array_position(p_fields,NULL) IS NOT NULL OR array_position(p_required_fields,NULL) IS NOT NULL
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field)
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_required_fields) field)
  OR NOT p_required_fields<@p_fields OR NOT coalesce(to_jsonb(p_fields)<@(mask->'read'),false)
  OR public.workflow_evidence_envelope_visible(w,policy#>'{metadata,scope}') IS NOT TRUE THEN
  RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 formula:=jsonb_build_object('kind','application_query','version',1,'clauses',jsonb_build_array(
  jsonb_build_object('scope',bounds,'read',mask->'read','selector',jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships','[]'::jsonb,'empty',false))));
 domain:=jsonb_build_object('kind','application_selector_domain','version',1,'formula',formula,
  'requiredFields',ARRAY(SELECT field FROM unnest(p_required_fields) field ORDER BY field));
 identity_value:=public.application_field_digest(jsonb_build_object('kind','application_selector_domain','workspaceId',w,'origin',origin,
  'schemaVersion',policy#>'{metadata,schemaVersion}','domain',domain));
 domain_id:=public.application_field_resource_uuid(identity_value);
 INSERT INTO public.application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,origin,canonical_type,policy#>>'{metadata,schemaVersion}',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM public.application_query_domains d WHERE d.workspace_id=w AND d.id=domain_id;
 IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity)
  IS DISTINCT FROM (origin,canonical_type,policy#>>'{metadata,schemaVersion}',domain,identity_value) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
 envelope:=public.application_compute_field_envelope(w,origin,canonical_type,domain_id,'query_domain',NULL,p_fields);
 IF envelope IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM public.application_materialize_field_envelope(w,envelope);
 RETURN jsonb_build_object('values','{}'::jsonb,'sources',jsonb_build_array(envelope->'source')||coalesce(envelope->'sources','[]'::jsonb),
  'policyVersion',envelope#>'{state,policyVersion}');
END $$;
REVOKE ALL ON FUNCTION observe_generic_application_query_domain(uuid,uuid,text,text[],text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION observe_generic_application_query_domain_before_points(uuid,uuid,text,text[],text[]) FROM app_user;
  REVOKE ALL ON FUNCTION application_selector_query_domain_state(uuid,jsonb,text,uuid,text[],public.application_query_domains),
   application_query_domain_state_before_points(uuid,jsonb,text,uuid,text[]),application_query_domain_state(uuid,jsonb,text,uuid,text[]),
   application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer),
   application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer),application_query_scope_admits_point(jsonb,jsonb),
   application_refine_query_points(uuid,uuid,text,jsonb,text[]),observe_application_query_points(uuid,uuid,text,text[],text[]) FROM app_user;
  GRANT EXECUTE ON FUNCTION observe_generic_application_query_domain(uuid,uuid,text,text[],text[]),
   assert_generic_application_query_candidates(uuid,uuid,uuid,text,jsonb) TO app_user;
 END IF;
END $$;
COMMIT;
