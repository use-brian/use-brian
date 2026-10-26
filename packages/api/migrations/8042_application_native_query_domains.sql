BEGIN;
-- [COMP:api/application-records] Fixed native codecs and structural metadata only.
CREATE FUNCTION application_native_query_field_metadata(w uuid,p_type text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE metadata jsonb;
BEGIN
 IF p_type NOT IN('company','person','deal') OR p_fields IS NULL OR cardinality(p_fields)>128
  OR array_position(p_fields,NULL) IS NOT NULL OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(item ORDER BY item->>'key'),'[]') INTO metadata FROM (
  SELECT jsonb_build_object('key',field,'kind','builtin','version',CASE WHEN p_type='deal' AND field='amount' THEN 2 ELSE 1 END) AS item
   FROM unnest(p_fields) field WHERE field=ANY(application_native_field_keys(p_type)) AND NOT EXISTS(
    SELECT 1 FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL AND 'custom.'||f.field_key=field)
  UNION ALL SELECT (to_jsonb(f)-ARRAY['label','position','created_at','updated_at'])||jsonb_build_object('key','custom.'||f.field_key)
   FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(p_fields)
 ) fields;
 IF jsonb_array_length(metadata)<>cardinality(p_fields) THEN RETURN NULL;END IF;
 RETURN metadata;
END $$;
REVOKE ALL ON FUNCTION application_native_query_field_metadata(uuid,text,text[]) FROM PUBLIC;

-- Reuse the existing every-layer catalog compiler; native metadata is a fixed port.
ALTER FUNCTION application_generic_query_catalog_policy(uuid,jsonb,text) RENAME TO application_query_catalog_policy_before_native;
REVOKE ALL ON FUNCTION application_query_catalog_policy_before_native(uuid,jsonb,text) FROM PUBLIC;
CREATE FUNCTION application_generic_query_catalog_policy(w uuid,p_origin jsonb,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb; keys text[]; metadata jsonb; fields jsonb; scope jsonb;
BEGIN
 IF p_origin<>'{"kind":"native","moduleKey":"native"}'::jsonb THEN
  RETURN application_query_catalog_policy_before_native(w,p_origin,p_type);
 END IF;
 IF p_type NOT IN('company','person','deal') THEN RETURN NULL;END IF;
 policy:=application_native_field_catalog_for(w,p_origin,p_type);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN RETURN policy;END IF;
 keys:=ARRAY(SELECT DISTINCT field FROM (
  SELECT unnest(application_native_field_keys(p_type)) AS field UNION SELECT 'custom.'||f.field_key FROM crm_field_definitions f
   WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL) fields ORDER BY field);
 metadata:=application_native_query_field_metadata(w,p_type,keys);IF metadata IS NULL THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',field,'read','[]'::jsonb,'write','[]'::jsonb,
  'releaseReadTo',jsonb_build_array('external_user','service'),'releaseWriteTo',jsonb_build_array('external_user','service')) ORDER BY field),'[]') INTO fields FROM unnest(keys) field;
 IF application_native_field_dictionary_valid(to_jsonb(keys),fields,'{}') IS NOT TRUE THEN RETURN NULL;END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb);
 RETURN jsonb_build_object('registered',true,'held',false,'nativeDefault',true,'roleKeys','[]'::jsonb,
  'metadata',jsonb_build_object('moduleKey','native','origin',p_origin,'typeKey',p_type,'schemaVersion',application_field_digest(metadata),
   'policyVersion','native-query-v1','fieldKeys',keys,'fields',fields,'scope',scope),
  'fingerprint',application_field_digest(jsonb_build_object('kind','native-query-v1','workspaceId',w,'typeKey',p_type,'fields',metadata,'scope',scope)));
END $$;
REVOKE ALL ON FUNCTION application_generic_query_catalog_policy(uuid,jsonb,text) FROM PUBLIC;

CREATE FUNCTION application_native_query_context(w uuid,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:='{"kind":"native","moduleKey":"native"}'; policy jsonb; admitted jsonb; formula jsonb; mask jsonb; bounds jsonb;
BEGIN
 IF p_type NOT IN('company','person','deal') OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entities'::regclass
  WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  admitted:=application_current_query_catalog(w,origin,p_type);IF admitted IS NULL THEN RETURN NULL;END IF;
  policy:=admitted->'policy';mask:=jsonb_build_object('read',admitted->'read');formula:=application_compile_query_catalog_domain(w,admitted);
 ELSE
  bounds:=application_native_query_bounds(w);IF bounds IS NULL THEN RETURN NULL;END IF;
  policy:=application_generic_query_catalog_policy(w,origin,p_type);
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR workflow_evidence_envelope_visible(w,policy#>'{metadata,scope}') IS NOT TRUE THEN RETURN NULL;END IF;
  IF policy->>'nativeDefault'='true' THEN
   mask:=application_native_member_field_permissions(w,policy,nullif(current_setting('app.current_user_id',true),'')::uuid);
  ELSE
   admitted:=read_native_application_field_catalog(w,origin,p_type);mask:=jsonb_build_object('read',admitted->'readFields');
  END IF;
  formula:=jsonb_build_object('kind','application_query','version',1,'clauses',jsonb_build_array(
   jsonb_build_object('scope',bounds,'read',mask->'read','selector',jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships','[]'::jsonb,'empty',false))));
 END IF;
 IF mask IS NULL OR jsonb_typeof(mask->'read') IS DISTINCT FROM 'array' OR formula IS NULL
  OR application_query_domain_contains(formula,formula,'{}') IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('policy',policy,'read',mask->'read','formula',formula);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_query_context(uuid,text) FROM PUBLIC;

-- Original selector/scope metadata narrows the domain; current query admission is
-- still checked for every canonical point. Business values never cross this port.
CREATE FUNCTION application_native_query_candidate_refs(w uuid,p_type text,formula jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_value record; scope jsonb; clause jsonb; matched boolean; state jsonb; result jsonb:='[]';
 origin jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF p_type NOT IN('company','person','deal') OR application_query_domain_contains(formula,formula,'{}') IS NOT TRUE THEN RETURN NULL;END IF;
 FOR row_value IN SELECT e.id,e.created_by_user_id FROM entities e WHERE e.workspace_id=w AND e.kind=p_type ORDER BY e.id LOOP
  scope:=read_scope_source(w,'entity',row_value.id);IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false'
   OR scope->>'validTo' IS NOT NULL OR scope->>'retractedAt' IS NOT NULL THEN CONTINUE;END IF;
  matched:=false;
  FOR clause IN SELECT value FROM jsonb_array_elements(formula->'clauses') LOOP
   IF clause#>>'{selector,empty}'='true' OR clause#>'{selector,ids}'<>'null' AND NOT clause#>'{selector,ids}' ? row_value.id::text
    OR clause#>>'{selector,ownerId}' IS NOT NULL AND clause#>>'{selector,ownerId}' IS DISTINCT FROM row_value.created_by_user_id::text
    OR application_query_scope_admits_point(clause->'scope',scope) IS NOT TRUE THEN CONTINUE;END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(clause#>'{selector,relationships}') relationship WHERE
    application_relationship_matches(w,origin,row_value.id::text,relationship->>'resolverKey',relationship->>'anchorId') IS NOT TRUE) THEN CONTINUE;END IF;
   matched:=true;EXIT;
  END LOOP;
  IF NOT matched THEN CONTINUE;END IF;
  state:=application_field_projection_state(w,origin,p_type,row_value.id,'query',NULL,'{}');
  IF state IS NULL THEN CONTINUE;END IF;
  result:=result||jsonb_build_array(jsonb_build_object('id',row_value.id,'version',state->>'recordVersion'));
  IF jsonb_array_length(result)>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION application_native_query_candidate_refs(uuid,text,jsonb) FROM PUBLIC;

ALTER FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) RENAME TO application_query_domain_state_before_native;
REVOKE ALL ON FUNCTION application_query_domain_state_before_native(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_query_domain_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains; current_context jsonb; policy jsonb; metadata jsonb; current_candidates jsonb;
BEGIN
 IF p_origin<>'{"kind":"native","moduleKey":"native"}'::jsonb THEN
  RETURN application_query_domain_state_before_native(w,p_origin,p_type,p_id,p_fields);
 END IF;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=p_id AND d.origin=p_origin AND d.type_key=p_type;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'native_query_domain_v1' OR frozen.domain->'version' IS DISTINCT FROM '1'::jsonb
  OR frozen.domain-ARRAY['kind','version','formula','requiredFields','candidates','fieldMetadata']<>'{}'::jsonb
  OR NOT frozen.domain ?& ARRAY['kind','version','formula','requiredFields','candidates','fieldMetadata']
  OR jsonb_typeof(frozen.domain->'requiredFields') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen.domain->'requiredFields')>128
  OR jsonb_typeof(frozen.domain->'candidates') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen.domain->'candidates')>4096 THEN RETURN NULL;END IF;
 current_context:=application_native_query_context(w,p_type);IF current_context IS NULL THEN RETURN NULL;END IF;
 policy:=current_context->'policy';metadata:=application_native_query_field_metadata(w,p_type,p_fields);
 IF metadata IS NULL OR metadata IS DISTINCT FROM frozen.domain->'fieldMetadata'
  OR policy#>>'{metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version
  OR NOT coalesce(to_jsonb(p_fields)<@(current_context->'read'),false)
  OR application_query_domain_contains(current_context->'formula',frozen.domain->'formula',
   ARRAY(SELECT jsonb_array_elements_text(frozen.domain->'requiredFields'))) IS NOT TRUE THEN RETURN NULL;END IF;
 current_candidates:=application_native_query_candidate_refs(w,p_type,frozen.domain->'formula');
 IF current_candidates IS NULL OR current_candidates IS DISTINCT FROM frozen.domain->'candidates' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',policy#>'{metadata,scope}','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',p_id,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('domain',frozen.identity,'fields',metadata)),
  'policyVersion',application_field_digest(jsonb_build_object('domain',frozen.identity,'catalog',policy->'fingerprint','fields',metadata)),
  'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION observe_native_application_query_domain(w uuid,p_type text,p_fields text[],p_required_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:='{"kind":"native","moduleKey":"native"}'; context jsonb; metadata jsonb; candidates jsonb; domain jsonb;
 identity_value text; domain_id uuid; frozen application_query_domains; envelope jsonb;
BEGIN
 context:=application_native_query_context(w,p_type);metadata:=application_native_query_field_metadata(w,p_type,p_fields);
 IF context IS NULL OR metadata IS NULL OR p_required_fields IS NULL OR cardinality(p_required_fields)>128
  OR array_position(p_required_fields,NULL) IS NOT NULL OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_required_fields) field)
  OR NOT p_required_fields<@p_fields OR NOT coalesce(to_jsonb(p_fields)<@(context->'read'),false)
  OR application_query_domain_contains(context->'formula',context->'formula',p_required_fields) IS NOT TRUE THEN
  RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 candidates:=application_native_query_candidate_refs(w,p_type,context->'formula');IF candidates IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 domain:=jsonb_build_object('kind','native_query_domain_v1','version',1,'formula',context->'formula','candidates',candidates,
  'fieldMetadata',metadata,'requiredFields',ARRAY(SELECT field FROM unnest(p_required_fields) field ORDER BY field));
 identity_value:=application_field_digest(jsonb_build_object('kind','native_query_domain_v1','workspaceId',w,'origin',origin,'typeKey',p_type,
  'schemaVersion',context#>'{policy,metadata,schemaVersion}','domain',domain));domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,origin,p_type,context#>>'{policy,metadata,schemaVersion}',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=domain_id;
 IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity)
  IS DISTINCT FROM (origin,p_type,context#>>'{policy,metadata,schemaVersion}',domain,identity_value) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 envelope:=application_compute_field_envelope(w,origin,p_type,domain_id,'query_domain',NULL,p_fields);
 IF envelope IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 PERFORM application_materialize_field_envelope(w,envelope);
 RETURN jsonb_build_object('values','{}'::jsonb,'sources',jsonb_build_array(envelope->'source')||coalesce(envelope->'sources','[]'::jsonb),
  'policyVersion',envelope#>'{state,policyVersion}');
END $$;
REVOKE ALL ON FUNCTION observe_native_application_query_domain(uuid,text,text[],text[]) FROM PUBLIC;

CREATE FUNCTION application_native_query_catalog(w uuid,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; custom_fields jsonb;
BEGIN
 context:=application_native_query_context(w,p_type);IF context IS NULL THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'entityKind',f.entity_kind,'fieldKey',f.field_key,'label',f.label,'fieldType',f.field_type,
  'options',f.options,'isRequired',f.is_required,'position',f.position) ORDER BY f.position,f.id),'[]') INTO custom_fields
  FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL AND context->'read' ? ('custom.'||f.field_key);
 RETURN jsonb_build_object('typeKey',p_type,'fields',context->'read','customFields',custom_fields);
END $$;
REVOKE ALL ON FUNCTION application_native_query_catalog(uuid,text) FROM PUBLIC;

CREATE FUNCTION read_native_application_query_candidates(w uuid,p_type text,p_fields text[],source_id uuid,source_version text)
RETURNS TABLE(id uuid,data jsonb,record_version text,sources jsonb,policy_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains; admitted jsonb; candidate jsonb; state jsonb; captured jsonb;
 origin jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 admitted:=read_admitted_application_field_snapshot(w,source_id,source_version);
 IF admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 SELECT d.* INTO frozen FROM application_field_resources field JOIN application_query_domains d ON d.id=field.resource_id
  WHERE field.id=source_id AND field.workspace_id=w AND field.selection='query_domain' AND d.workspace_id=w AND d.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND d.type_key=p_type
   AND field.fields @> p_fields
   AND (d.domain->'requiredFields')=to_jsonb(p_fields);
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'native_query_domain_v1' THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 FOR candidate IN SELECT value FROM jsonb_array_elements(frozen.domain->'candidates') LOOP
  state:=application_field_projection_state(w,origin,p_type,(candidate->>'id')::uuid,'query',NULL,p_fields);
  IF state IS NULL OR state->>'recordVersion' IS DISTINCT FROM candidate->>'version' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  captured:=observe_application_field_projection(w,origin,p_type,(candidate->>'id')::uuid,state->>'recordVersion','query',NULL,p_fields);
  IF captured IS NULL OR captured->'values' IS DISTINCT FROM state->'values' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  id:=(candidate->>'id')::uuid;data:=captured->'values';record_version:=state->>'recordVersion';sources:=captured->'sources';policy_version:=captured->>'policyVersion';RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_application_query_candidates(uuid,text,text[],uuid,text) FROM PUBLIC;
-- Output fields are consumed only for selected page rows, after admitted predicates.
CREATE FUNCTION read_native_application_query_records(w uuid,p_type text,p_ids uuid[],p_versions text[],p_fields text[],source_id uuid,source_version text)
RETURNS TABLE(id uuid,data jsonb,sources jsonb,policy_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains; admitted jsonb; state jsonb; captured jsonb; candidate record;
 origin jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF p_ids IS NULL OR p_versions IS NULL OR cardinality(p_ids)>100 OR cardinality(p_ids)<>cardinality(p_versions)
  OR array_position(p_ids,NULL) IS NOT NULL OR array_position(p_versions,NULL) IS NOT NULL
  OR (SELECT count(*)<>count(DISTINCT record_id) FROM unnest(p_ids) record_id) THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
 admitted:=read_admitted_application_field_snapshot(w,source_id,source_version);
 IF admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 SELECT d.* INTO frozen FROM application_field_resources field JOIN application_query_domains d ON d.id=field.resource_id
  WHERE field.id=source_id AND field.workspace_id=w AND field.selection='query_domain' AND d.workspace_id=w
   AND d.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND d.type_key=p_type AND field.fields @> p_fields;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'native_query_domain_v1' THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 FOR candidate IN SELECT * FROM unnest(p_ids,p_versions) records(record_id,version) LOOP
  IF NOT frozen.domain->'candidates' @> jsonb_build_array(jsonb_build_object('id',candidate.record_id,'version',candidate.version)) THEN
   RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
  state:=application_field_projection_state(w,origin,p_type,candidate.record_id,'query',NULL,p_fields);
  IF state IS NULL OR state->>'recordVersion' IS DISTINCT FROM candidate.version THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  captured:=observe_application_field_projection(w,origin,p_type,candidate.record_id,candidate.version,'query',NULL,p_fields);
  IF captured IS NULL OR captured->'values' IS DISTINCT FROM state->'values' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  id:=candidate.record_id;data:=captured->'values';sources:=captured->'sources';policy_version:=captured->>'policyVersion';RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_application_query_records(uuid,text,uuid[],text[],text[],uuid,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION observe_native_application_query_domain(uuid,text,text[],text[]),application_native_query_catalog(uuid,text),
   read_native_application_query_candidates(uuid,text,text[],uuid,text),read_native_application_query_records(uuid,text,uuid[],text[],text[],uuid,text) TO app_user;
 END IF;
END $$;
COMMIT;
