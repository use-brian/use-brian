BEGIN;
-- [COMP:api/application-records] One shared structural compiler. The additional
-- native result describes data partitions, never an original actor's authority.
ALTER FUNCTION application_compile_query_catalog_domain(uuid,jsonb) RENAME TO application_compile_query_catalog_domain_before_native_v2;
REVOKE ALL ON FUNCTION application_compile_query_catalog_domain_before_native_v2(uuid,jsonb) FROM PUBLIC;
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.application_compile_query_catalog_domain_before_native_v2(uuid,jsonb)'::regprocedure) INTO definition;
 before:='application_compile_query_catalog_domain_before_native_v2(w uuid, admitted jsonb)';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Query compiler signature changed';END IF;
 definition:=replace(definition,before,'application_compile_query_catalog_domain(w uuid, admitted jsonb, p_private_actor uuid)');
 before:='layer_index int:=0;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Query compiler declaration changed';END IF;
 definition:=replace(definition,before,before||' private_allowed boolean;');
 before:='scope:=NULL;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Query compiler path changed';END IF;
 definition:=replace(definition,before,before||'private_allowed:=p_private_actor IS NOT NULL;');
 before:='current_scope:=public.application_principal_query_bounds(w,(principal#>>''{}'')::uuid,true);';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Query compiler issuer/member floor changed';END IF;
 definition:=replace(definition,before,before||'private_allowed:=private_allowed AND (principal#>>''{}'')::uuid=p_private_actor;');
 before:=$source$jsonb_build_object('scope',scope,'selector',selectors,'read',path->'read')$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Query compiler layer changed';END IF;
 definition:=replace(definition,before,$source$jsonb_build_object('scope',scope,'selector',selectors,'read',path->'read','private',private_allowed)$source$);
 before:=$source$jsonb_build_object('scope',current_scope,'selector',selectors,'read',readable)$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Query compiler intersection changed';END IF;
 definition:=replace(definition,before,$source$jsonb_build_object('scope',current_scope,'selector',selectors,'read',readable,'private',(left_clause->>'private')::boolean AND (right_clause->>'private')::boolean)$source$);
 before:=$source$RETURN jsonb_build_object('kind','application_query','version',1,'clauses',to_jsonb(clauses));$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Query compiler result changed';END IF;
 EXECUTE replace(definition,before,$source$RETURN jsonb_build_object(
  'formula',jsonb_build_object('kind','application_query','version',1,'clauses',
    (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (SELECT DISTINCT value-'private' AS value FROM unnest(clauses) value) regular)),
  'privateFormula',jsonb_build_object('kind','application_query','version',1,'clauses',
    (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (SELECT DISTINCT value-'private' AS value FROM unnest(clauses) value WHERE value->>'private'='true') private_only)));$source$);
END $migration$;
REVOKE ALL ON FUNCTION application_compile_query_catalog_domain(uuid,jsonb,uuid) FROM PUBLIC;
CREATE FUNCTION application_compile_query_catalog_domain(w uuid,admitted jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.application_compile_query_catalog_domain(w,admitted,NULL)->'formula'
$$;
REVOKE ALL ON FUNCTION application_compile_query_catalog_domain(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_native_query_visibility() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 assistants jsonb:=coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb);
BEGIN
 IF actor IS NULL OR jsonb_typeof(assistants) NOT IN('array','null') THEN RETURN NULL;END IF;
 IF assistants<>'null' THEN
  IF jsonb_array_length(assistants)>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(assistants) item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL;END IF;
  PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(assistants);
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO assistants FROM (SELECT DISTINCT value FROM jsonb_array_elements(assistants)) ordered;
 END IF;
 RETURN jsonb_build_object('userId',actor,'assistants',assistants,'shared',current_setting('app.agent_shared_audience',true)='true');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_query_visibility() FROM PUBLIC;
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.application_native_query_context(uuid,text)'::regprocedure) INTO definition;
 before:='mask jsonb; bounds jsonb;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native query context declaration changed';END IF;
 definition:=replace(definition,before,before||' compiled jsonb;private_formula jsonb;visibility jsonb;');
 before:='policy:=admitted->''policy'';mask:=jsonb_build_object(''read'',admitted->''read'');formula:=application_compile_query_catalog_domain(w,admitted);';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native query compiler binding changed';END IF;
 definition:=replace(definition,before,$source$policy:=admitted->'policy';mask:=jsonb_build_object('read',admitted->'read');
  compiled:=application_compile_query_catalog_domain(w,admitted,nullif(current_setting('app.current_user_id',true),'')::uuid);
  formula:=compiled->'formula';private_formula:=compiled->'privateFormula';$source$);
 before:=$source$RETURN jsonb_build_object('policy',policy,'read',mask->'read','formula',formula);$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native query context result changed';END IF;
 EXECUTE replace(definition,before,$source$visibility:=application_native_query_visibility();IF visibility IS NULL THEN RETURN NULL;END IF;
 IF private_formula IS NULL THEN private_formula:=formula;END IF;
 IF visibility->>'shared'='true' THEN private_formula:=jsonb_build_object('kind','application_query','version',1,'clauses','[]'::jsonb);END IF;
 IF application_query_domain_contains(private_formula,private_formula,'{}') IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('policy',policy,'read',mask->'read','formula',formula,'privateFormula',private_formula,
  'visibility',jsonb_build_object('userId',CASE WHEN jsonb_array_length(private_formula->'clauses')>0 THEN visibility->'userId' ELSE 'null'::jsonb END,'assistants',visibility->'assistants'));$source$);
END $migration$;

CREATE FUNCTION application_native_query_refs(w uuid,p_type text,formula jsonb,private_formula jsonb,visibility jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_value record;scope jsonb;clause jsonb;selected_formula jsonb;matched boolean;state jsonb;result jsonb:='[]';
 origin jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF p_type NOT IN('company','person','deal') OR application_query_domain_contains(formula,formula,'{}') IS NOT TRUE
  OR application_query_domain_contains(private_formula,private_formula,'{}') IS NOT TRUE
  OR visibility IS NULL OR visibility-ARRAY['userId','assistants']<>'{}' OR NOT visibility ?& ARRAY['userId','assistants']
  OR jsonb_typeof(visibility->'userId') NOT IN('string','null') OR jsonb_typeof(visibility->'assistants') NOT IN('array','null') THEN RETURN NULL;END IF;
 IF visibility->>'userId' IS NOT NULL THEN PERFORM (visibility->>'userId')::uuid;END IF;
 IF visibility->'assistants'<>'null' THEN
  IF jsonb_array_length(visibility->'assistants')>256 THEN RETURN NULL;END IF;
  PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(visibility->'assistants');
 END IF;
 FOR row_value IN SELECT e.id,e.created_by_user_id FROM entities e WHERE e.workspace_id=w AND e.kind=p_type ORDER BY e.id LOOP
  scope:=read_scope_source(w,'entity',row_value.id);
  IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' OR scope->>'validTo' IS NOT NULL OR scope->>'retractedAt' IS NOT NULL THEN CONTINUE;END IF;
  IF scope->>'assistantId' IS NOT NULL AND visibility->'assistants'<>'null' AND NOT visibility->'assistants' ? (scope->>'assistantId') THEN CONTINUE;END IF;
  IF scope->>'userId' IS NULL THEN selected_formula:=formula;
  ELSIF scope->>'userId'=visibility->>'userId' THEN selected_formula:=private_formula;
  ELSE CONTINUE;END IF;
  matched:=false;
  FOR clause IN SELECT value FROM jsonb_array_elements(selected_formula->'clauses') LOOP
   IF clause#>>'{selector,empty}'='true' OR clause#>'{selector,ids}'<>'null' AND NOT clause#>'{selector,ids}' ? row_value.id::text
    OR clause#>>'{selector,ownerId}' IS NOT NULL AND clause#>>'{selector,ownerId}' IS DISTINCT FROM row_value.created_by_user_id::text
    OR application_query_scope_admits_point(clause->'scope',scope) IS NOT TRUE THEN CONTINUE;END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(clause#>'{selector,relationships}') relationship WHERE
    application_relationship_matches(w,origin,row_value.id::text,relationship->>'resolverKey',relationship->>'anchorId') IS NOT TRUE) THEN CONTINUE;END IF;
   matched:=true;EXIT;
  END LOOP;
  IF NOT matched THEN CONTINUE;END IF;
  state:=application_field_projection_state(w,origin,p_type,row_value.id,'query',NULL,'{}');
  IF state IS NULL THEN RETURN NULL;END IF;
  result:=result||jsonb_build_array(jsonb_build_object('id',row_value.id,'version',state->>'recordVersion'));
  IF jsonb_array_length(result)>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_query_refs(uuid,text,jsonb,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_native_query_remainder(formula jsonb,point_ids jsonb,required_fields text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE clause jsonb;ids jsonb;clauses jsonb:='[]';
BEGIN
 FOR clause IN SELECT value FROM jsonb_array_elements(formula->'clauses') LOOP
  clause:=jsonb_set(clause,'{read}',to_jsonb(required_fields));
  IF clause#>'{selector,ids}'='null' THEN clauses:=clauses||jsonb_build_array(clause);CONTINUE;END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO ids FROM jsonb_array_elements(clause#>'{selector,ids}') WHERE NOT point_ids @> jsonb_build_array(value);
  IF jsonb_array_length(ids)>0 THEN clauses:=clauses||jsonb_build_array(jsonb_set(clause,'{selector,ids}',ids));
  ELSIF jsonb_array_length(clause#>'{selector,relationships}')>0 THEN
   clauses:=clauses||jsonb_build_array(jsonb_set(jsonb_set(clause,'{selector,ids}','[]'::jsonb),'{selector,empty}','true'::jsonb));
  END IF;
 END LOOP;
 RETURN formula||jsonb_build_object('clauses',(SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (SELECT DISTINCT value FROM jsonb_array_elements(clauses)) canonical));
END $$;
REVOKE ALL ON FUNCTION application_native_query_remainder(jsonb,jsonb,text[]) FROM PUBLIC;

-- Keep the former native implementation for guarded compatibility proofs only.
ALTER FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) RENAME TO application_query_domain_state_before_native_visibility;
REVOKE ALL ON FUNCTION application_query_domain_state_before_native_visibility(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_query_domain_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;context jsonb;policy jsonb;metadata jsonb;remaining jsonb;candidates jsonb;point jsonb;has_domain boolean;
BEGIN
 IF p_origin<>'{"kind":"native","moduleKey":"native"}'::jsonb THEN
  RETURN application_query_domain_state_before_native_visibility(w,p_origin,p_type,p_id,p_fields);
 END IF;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=p_id AND d.origin=p_origin AND d.type_key=p_type;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'native_query_domain_v2' OR frozen.domain->'version' IS DISTINCT FROM '2'::jsonb
  OR frozen.domain-ARRAY['kind','version','formula','privateFormula','visibility','queryPoints','requiredFields','candidates','fieldMetadata']<>'{}'
  OR NOT frozen.domain ?& ARRAY['kind','version','formula','privateFormula','visibility','queryPoints','requiredFields','candidates','fieldMetadata']
  OR jsonb_typeof(frozen.domain->'queryPoints') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen.domain->'queryPoints')>4096
  OR jsonb_typeof(frozen.domain->'requiredFields') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen.domain->'requiredFields')>128
  OR jsonb_typeof(frozen.domain->'candidates') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen.domain->'candidates')>4096 THEN RETURN NULL;END IF;
 context:=application_native_query_context(w,p_type);IF context IS NULL THEN RETURN NULL;END IF;
 policy:=context->'policy';metadata:=application_native_query_field_metadata(w,p_type,p_fields);
 IF metadata IS NULL OR metadata IS DISTINCT FROM frozen.domain->'fieldMetadata'
  OR policy#>>'{metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version OR NOT coalesce(to_jsonb(p_fields)<@(context->'read'),false)
  OR application_query_domain_contains(context->'formula',frozen.domain->'formula',ARRAY(SELECT jsonb_array_elements_text(frozen.domain->'requiredFields'))) IS NOT TRUE THEN RETURN NULL;END IF;
 has_domain:=EXISTS(SELECT 1 FROM jsonb_array_elements(frozen.domain#>'{formula,clauses}') clause WHERE clause#>>'{selector,empty}' IS DISTINCT FROM 'true');
 IF has_domain AND application_query_set_intersection(context#>'{visibility,assistants}',frozen.domain#>'{visibility,assistants}') IS DISTINCT FROM frozen.domain#>'{visibility,assistants}' THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(frozen.domain#>'{privateFormula,clauses}') clause WHERE clause#>>'{selector,empty}' IS DISTINCT FROM 'true') THEN
  IF context#>>'{visibility,userId}' IS DISTINCT FROM frozen.domain#>>'{visibility,userId}'
   OR application_query_domain_contains(context->'privateFormula',frozen.domain->'privateFormula',ARRAY(SELECT jsonb_array_elements_text(frozen.domain->'requiredFields'))) IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 remaining:=application_native_query_refs(w,p_type,frozen.domain->'formula',frozen.domain->'privateFormula',frozen.domain->'visibility');
 IF remaining IS NULL THEN RETURN NULL;END IF;
 FOR point IN SELECT value FROM jsonb_array_elements(frozen.domain->'queryPoints') LOOP
  remaining:=remaining||jsonb_build_array(jsonb_build_object('id',point->'id','version',point->'version'));
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]') INTO candidates FROM (SELECT DISTINCT value FROM jsonb_array_elements(remaining)) canonical;
 IF candidates IS DISTINCT FROM frozen.domain->'candidates' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',policy#>'{metadata,scope}','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',p_id,'sourceVersion',frozen.identity,
  'ownerId',NULL,'fieldIdentity',application_field_digest(jsonb_build_object('domain',frozen.identity,'fields',metadata)),
  'policyVersion',application_field_digest(jsonb_build_object('domain',frozen.identity,'catalog',policy->'fingerprint','fields',metadata)),
  'references','[]'::jsonb,'queryPoints',frozen.domain->'queryPoints');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;

ALTER FUNCTION observe_native_application_query_domain(uuid,text,text[],text[]) RENAME TO observe_native_application_query_domain_before_visibility;
REVOKE ALL ON FUNCTION observe_native_application_query_domain_before_visibility(uuid,text,text[],text[]) FROM PUBLIC;
CREATE FUNCTION observe_native_application_query_domain(w uuid,p_type text,p_fields text[],p_required_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:='{"kind":"native","moduleKey":"native"}';context jsonb;metadata jsonb;candidates jsonb;domain jsonb;
 candidate jsonb;child jsonb;points jsonb:='[]';point_ids jsonb:='[]';formula jsonb;private_formula jsonb;visibility jsonb;
 identity_value text;domain_id uuid;frozen application_query_domains;envelope jsonb;
BEGIN
 context:=application_native_query_context(w,p_type);metadata:=application_native_query_field_metadata(w,p_type,p_fields);
 IF context IS NULL OR metadata IS NULL OR p_required_fields IS NULL OR cardinality(p_required_fields)>128
  OR array_position(p_required_fields,NULL) IS NOT NULL OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_required_fields) field)
  OR NOT p_required_fields<@p_fields OR NOT coalesce(to_jsonb(p_fields)<@(context->'read'),false)
  OR application_query_domain_contains(context->'formula',context->'formula',p_required_fields) IS NOT TRUE THEN
  RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 p_required_fields:=ARRAY(SELECT field FROM unnest(p_required_fields) field ORDER BY field);
 candidates:=application_native_query_refs(w,p_type,context->'formula',context->'privateFormula',context->'visibility');
 IF candidates IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 FOR candidate IN SELECT value FROM jsonb_array_elements(candidates) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(context#>'{formula,clauses}') clause WHERE clause#>'{selector,ids}'<>'null' AND clause#>'{selector,ids}' ? (candidate->>'id')) THEN CONTINUE;END IF;
  child:=application_compute_field_envelope(w,origin,p_type,(candidate->>'id')::uuid,'query',NULL,p_required_fields,1);
  IF child IS NULL OR child#>>'{state,recordVersion}' IS DISTINCT FROM candidate->>'version' THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
  points:=points||jsonb_build_array(jsonb_build_object('id',candidate->'id','version',candidate->'version','fields',p_required_fields,'source',child->'source'));
  point_ids:=point_ids||jsonb_build_array(candidate->'id');
 END LOOP;
 formula:=application_native_query_remainder(context->'formula',point_ids,p_required_fields);
 private_formula:=application_native_query_remainder(context->'privateFormula',point_ids,p_required_fields);
 visibility:=context->'visibility';
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(private_formula->'clauses') clause WHERE clause#>>'{selector,empty}' IS DISTINCT FROM 'true') THEN visibility:=jsonb_set(visibility,'{userId}','null');END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(formula->'clauses') clause WHERE clause#>>'{selector,empty}' IS DISTINCT FROM 'true') THEN visibility:=jsonb_set(visibility,'{assistants}','null');END IF;
 domain:=jsonb_build_object('kind','native_query_domain_v2','version',2,'formula',formula,'privateFormula',private_formula,'visibility',visibility,
  'queryPoints',points,'candidates',candidates,'fieldMetadata',metadata,'requiredFields',ARRAY(SELECT field FROM unnest(p_required_fields) field ORDER BY field));
 identity_value:=application_field_digest(jsonb_build_object('kind','native_query_domain_v2','workspaceId',w,'origin',origin,'typeKey',p_type,
  'schemaVersion',context#>'{policy,metadata,schemaVersion}','domain',domain));domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,origin,p_type,context#>>'{policy,metadata,schemaVersion}',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=domain_id;
 IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity)
  IS DISTINCT FROM (origin,p_type,context#>>'{policy,metadata,schemaVersion}',domain,identity_value) THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 envelope:=application_compute_field_envelope(w,origin,p_type,domain_id,'query_domain',NULL,p_fields);
 IF envelope IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 PERFORM application_materialize_field_envelope(w,envelope);
 RETURN jsonb_build_object('values','{}'::jsonb,'sources',jsonb_build_array(envelope->'source')||coalesce(envelope->'sources','[]'::jsonb),
  'policyVersion',envelope#>'{state,policyVersion}');
END $$;
REVOKE ALL ON FUNCTION observe_native_application_query_domain(uuid,text,text[],text[]) FROM PUBLIC;
DO $migration$
DECLARE definition text;signature text;
BEGIN
 FOR signature IN SELECT unnest(ARRAY['public.read_native_application_query_candidates(uuid,text,text[],uuid,text)',
  'public.read_native_application_query_records(uuid,text,uuid[],text[],text[],uuid,text)']) LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
  IF position('native_query_domain_v1' IN definition)=0 THEN RAISE EXCEPTION 'Native query capture port changed';END IF;
  EXECUTE replace(definition,'native_query_domain_v1','native_query_domain_v2');
 END LOOP;
 SELECT pg_get_functiondef('public.application_native_query_catalog(uuid,text)'::regprocedure) INTO definition;
 IF position('native-query-schema-v2' IN definition)=0 THEN RAISE EXCEPTION 'Native query cursor schema changed';END IF;
 EXECUTE replace(definition,'native-query-schema-v2','native-query-schema-v3');
END $migration$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION observe_native_application_query_domain(uuid,text,text[],text[]) TO app_user;
 END IF;
END $$;
COMMIT;
