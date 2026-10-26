BEGIN;
-- [COMP:security/native-field-policy] Immutable semantic query obligations use
-- each reader's own grants, never the original app, actor or issuer as a permit.
CREATE FUNCTION application_current_query_catalog_for_origin(w uuid,p_origin jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; policy jsonb; layer jsonb; maximum jsonb; path jsonb; paths jsonb; layers jsonb:='[]';
 layer_fields text[]; readable text[]; admitted boolean; canonical_type text;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_types'::regclass
  WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL; END IF;
 context:=public.application_current_maxima();
 IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN NULL; END IF;
 canonical_type:='record.'||(p_origin->>'entityTypeId')::uuid;
 policy:=public.application_generic_query_catalog_policy(w,p_origin,canonical_type);
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
  OR public.agent_visibility_allows(w,(policy#>>'{metadata,scope,userId}')::uuid,(policy#>>'{metadata,scope,assistantId}')::uuid) IS NOT TRUE THEN RETURN NULL; END IF;
 FOR layer IN SELECT value FROM jsonb_array_elements(context->'layers') LOOP
  layer_fields:='{}';admitted:=false;paths:='[]';
  FOR maximum IN SELECT value FROM jsonb_array_elements(layer->'maxima') LOOP
   path:=public.application_query_catalog_path(context,maximum,layer->'principal',w,p_origin,maximum#>>'{grants,0,typeKey}',policy);
   IF path IS NULL THEN CONTINUE; END IF;
   admitted:=true;layer_fields:=layer_fields||ARRAY(SELECT jsonb_array_elements_text(path->'read'));paths:=paths||jsonb_build_array(path);
  END LOOP;
  IF NOT admitted THEN RETURN NULL; END IF;
  IF readable IS NULL THEN readable:=layer_fields;
  ELSE readable:=ARRAY(SELECT unnest(readable) INTERSECT SELECT unnest(layer_fields)); END IF;
  layers:=layers||jsonb_build_array(paths);
 END LOOP;
 IF readable IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('read',ARRAY(SELECT DISTINCT unnest(readable) ORDER BY 1),'policy',policy,'layers',layers);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_current_query_catalog_for_origin(uuid,jsonb) FROM PUBLIC;

-- Resolve the declared anchor from canonical schema metadata. This does not
-- construct a relation cell or choose a surrogate business record.
CREATE FUNCTION application_query_anchor_reference(w uuid,p_origin jsonb,resolver_key text,anchor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE property jsonb; target_origin jsonb; target_type text; reference jsonb; context jsonb; layer jsonb; maximum jsonb;
 scope jsonb; decision jsonb; admitted boolean; current_alias text;
BEGIN
 IF p_origin->>'kind' IS DISTINCT FROM 'generic' THEN RETURN NULL; END IF;
 PERFORM anchor_id::uuid;
 SELECT p INTO property FROM public.entity_types t,LATERAL jsonb_array_elements(t.properties) p
  WHERE t.workspace_id=w AND t.id=(p_origin->>'entityTypeId')::uuid AND p#>>'{config,kind}'='relation'
   AND 'relation.'||encode(sha256(convert_to(p->>'name','UTF8')),'hex')=resolver_key;
 IF property IS NULL THEN RETURN NULL; END IF;
 IF property#>>'{config,targetEntityTypeRef,kind}'='user_defined' THEN
  target_origin:=jsonb_build_object('kind','generic','entityTypeId',(property#>>'{config,targetEntityTypeRef,entityTypeId}')::uuid);
  target_type:='record.'||(target_origin->>'entityTypeId');
 ELSIF property#>>'{config,targetEntityTypeRef,kind}'='builtin'
  AND property#>>'{config,targetEntityTypeRef,name}' IN('company','contact','deal','task') THEN
  target_origin:=jsonb_build_object('kind','native','moduleKey','native');
  target_type:=CASE property#>>'{config,targetEntityTypeRef,name}' WHEN 'contact' THEN 'person' ELSE property#>>'{config,targetEntityTypeRef,name}' END;
 ELSE RETURN NULL; END IF;
 reference:=jsonb_build_object('origin',target_origin,'typeKey',target_type,'id',anchor_id::uuid,'fields','[]'::jsonb);
 IF public.application_field_reference_admitted(w,reference) IS NOT TRUE THEN RETURN NULL; END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN RETURN reference; END IF;
 context:=public.application_current_maxima();
 IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN NULL; END IF;
 scope:=public.application_reference_scope(w,target_origin,target_type,anchor_id::uuid);
 IF scope IS NULL THEN RETURN NULL; END IF;
 FOR layer IN SELECT value FROM jsonb_array_elements(context->'layers') LOOP
  admitted:=false;
  FOR maximum IN SELECT value FROM jsonb_array_elements(layer->'maxima') LOOP
   current_alias:=maximum#>>'{grants,0,typeKey}';
   IF maximum#>'{grants,0,origin}' IS DISTINCT FROM target_origin
    OR target_origin->>'kind'='native' AND current_alias IS DISTINCT FROM target_type
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(maximum->'grants') issued
     LEFT JOIN public.application_access_grants current_grant ON current_grant.id=(issued->>'id')::uuid
     WHERE issued#>>'{selector,kind}'='relationship' OR current_grant.selector->>'kind'='relationship') THEN CONTINUE; END IF;
   decision:=public.application_path_fields(maximum,layer->'principal',w,target_origin,current_alias,anchor_id,
    (scope->>'ownerId')::uuid,scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),
    ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds'))::uuid[],(scope->>'userId')::uuid,'read');
   IF decision IS NOT NULL THEN admitted:=true;EXIT; END IF;
  END LOOP;
  IF NOT admitted THEN RETURN NULL; END IF;
 END LOOP;
 RETURN reference;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_anchor_reference(uuid,jsonb,text,text) FROM PUBLIC;

ALTER FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) RENAME TO application_query_domain_state_before_selectors;
REVOKE ALL ON FUNCTION application_query_domain_state_before_selectors(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_query_domain_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen public.application_query_domains; admitted jsonb; policy jsonb; current_domain jsonb; bounds jsonb; mask jsonb;
 properties jsonb; anchor_refs jsonb:='[]'; relationship jsonb; reference jsonb; required text[];
BEGIN
 SELECT * INTO frozen FROM public.application_query_domains d WHERE d.workspace_id=w AND d.id=p_id AND d.origin=p_origin AND d.type_key=p_type;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF frozen.domain->>'kind' IS DISTINCT FROM 'application_selector_domain' THEN
  RETURN public.application_query_domain_state_before_selectors(w,p_origin,p_type,p_id,p_fields);
 END IF;
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
REVOKE ALL ON FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION observe_generic_application_query_domain(w uuid,p_type uuid,p_alias text,p_fields text[],p_required_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type); canonical_type text:='record.'||p_type;
 admitted jsonb; formula jsonb; domain jsonb; identity_value text; domain_id uuid; envelope jsonb; frozen public.application_query_domains;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN
  RETURN public.observe_generic_native_query_domain(w,p_type,p_fields);
 END IF;
 IF p_fields IS NULL OR p_required_fields IS NULL OR cardinality(p_fields)>128 OR cardinality(p_required_fields)>128
  OR array_position(p_fields,NULL) IS NOT NULL OR array_position(p_required_fields,NULL) IS NOT NULL
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field)
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_required_fields) field)
  OR NOT p_required_fields<@p_fields THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 admitted:=public.application_current_query_catalog(w,origin,p_alias);
 IF admitted IS NULL OR NOT to_jsonb(p_fields)<@(admitted->'read') THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 formula:=public.application_compile_query_catalog_domain(w,admitted);
 IF public.application_query_domain_contains(formula,formula,p_required_fields) IS NOT TRUE THEN
  RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 domain:=jsonb_build_object('kind','application_selector_domain','version',1,'formula',formula,
  'requiredFields',ARRAY(SELECT field FROM unnest(p_required_fields) field ORDER BY field));
 identity_value:=public.application_field_digest(jsonb_build_object('kind','application_selector_domain','workspaceId',w,'origin',origin,
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
REVOKE ALL ON FUNCTION observe_generic_application_query_domain(uuid,uuid,text,text[],text[]) FROM PUBLIC;

-- The canonical candidate port below keeps its existing row/field admission.
-- Its row-free branch captures the same predicate-specific domain as the host.

CREATE OR REPLACE FUNCTION read_generic_application_query_candidates(w uuid,p_type uuid,p_alias text,p_required_fields text[] DEFAULT '{}',p_catalog_fields text[] DEFAULT '{}')
RETURNS TABLE(id uuid,workspace_id uuid,entity_type_id uuid,data jsonb,record_version bigint,
 created_at timestamptz,last_edited_at timestamptz,created_by uuid,last_edited_by uuid,
 source jsonb,absent_fields text[],policy_version text,read_fields text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; context jsonb; catalog jsonb; decision jsonb;
 native_policy jsonb; captured jsonb; row_value record; property jsonb; origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type);
 candidate_count int:=0;
BEGIN
 IF actor IS NULL OR p_required_fields IS NULL OR cardinality(p_required_fields)>256 OR array_position(p_required_fields,NULL) IS NOT NULL
  OR p_catalog_fields IS NULL OR cardinality(p_catalog_fields)>256 OR array_position(p_catalog_fields,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_instances'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 catalog:=application_native_field_catalog_for(w,origin,p_alias);
 IF catalog->>'registered'='true' THEN
  IF catalog->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  IF context IS NULL THEN
   decision:=read_native_application_field_catalog(w,origin,p_alias);
   IF decision IS NULL OR NOT to_jsonb(p_catalog_fields)<@(decision->'readFields') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
 END IF;
 FOR row_value IN SELECT r.* FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=p_type ORDER BY r.id LOOP
  IF scope_review_state_held('entity_instance',row_value.id) THEN CONTINUE; END IF;
  IF context IS NULL THEN
   IF read_admitted_native_scope_snapshot(w,'entity_instance',row_value.id) IS NULL THEN CONTINUE; END IF;
   native_policy:=application_native_field_contract_for(w,origin,p_alias,row_value.id::text);
   IF native_policy->>'registered'='true' THEN
    IF native_policy->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
    IF agent_visibility_allows(w,(native_policy#>>'{metadata,source,userId}')::uuid,(native_policy#>>'{metadata,source,assistantId}')::uuid) IS NOT TRUE
     OR workflow_evidence_envelope_visible(w,native_policy#>'{metadata,source}') IS NOT TRUE THEN CONTINUE; END IF;
   END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM application_generic_projection(p_type,p_alias,'query',row_value.id)) THEN CONTINUE; END IF;
   IF catalog->>'registered'='true' THEN
    decision:=application_resource_fields(w,origin,p_alias,row_value.id::text,row_value.created_by,catalog#>>'{metadata,scope,sensitivity}',
     ARRAY(SELECT jsonb_array_elements_text(catalog#>'{metadata,scope,compartments}')),
     ARRAY(SELECT jsonb_array_elements_text(catalog#>'{metadata,scope,projectIds}'))::uuid[],
     (catalog#>>'{metadata,scope,userId}')::uuid,'query');
    IF decision IS NULL OR NOT to_jsonb(p_catalog_fields)<@(decision->'read') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
   END IF;
  END IF;
  candidate_count:=candidate_count+1;
  IF candidate_count>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501'; END IF;
  captured:=read_generic_application_projection(w,p_type,p_alias,row_value.id,'query',NULL,p_required_fields);
  id:=row_value.id;workspace_id:=w;entity_type_id:=p_type;data:=captured->'values';record_version:=(captured->>'recordVersion')::bigint;
  source:=captured#>'{sources,0}';absent_fields:=ARRAY(SELECT jsonb_array_elements_text(captured->'absentFields'));policy_version:=captured->>'policyVersion';
  read_fields:=ARRAY(SELECT field FROM (SELECT jsonb_object_keys(data) AS field UNION SELECT unnest(absent_fields)) fields ORDER BY field);
  created_at:=NULL;last_edited_at:=NULL;created_by:=NULL;last_edited_by:=NULL;
  FOR property IN SELECT p FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p WHERE t.workspace_id=w AND t.id=p_type AND data ? (p->>'name') LOOP
   CASE property#>>'{config,kind}'
    WHEN 'created_time' THEN created_at:=row_value.created_at;
    WHEN 'last_edited_time' THEN last_edited_at:=row_value.last_edited_at;
    WHEN 'created_by' THEN created_by:=row_value.created_by;
    WHEN 'last_edited_by' THEN last_edited_by:=row_value.last_edited_by;
    ELSE NULL;
   END CASE;
  END LOOP;
  RETURN NEXT;
 END LOOP;
 -- A row-free domain needs its separate immutable catalog/domain observation.
 -- Until that consumer is wired, never manufacture empty General evidence.
 IF candidate_count=0 AND public.observe_generic_application_query_domain(w,p_type,p_alias,p_catalog_fields,p_required_fields) IS NULL THEN
  RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
END $$;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION application_current_query_catalog_for_origin(uuid,jsonb),application_query_anchor_reference(uuid,jsonb,text,text),
   application_query_domain_state_before_selectors(uuid,jsonb,text,uuid,text[]),application_query_domain_state(uuid,jsonb,text,uuid,text[]) FROM app_user;
  GRANT EXECUTE ON FUNCTION observe_generic_application_query_domain(uuid,uuid,text,text[],text[]) TO app_user;
 END IF;
END $$;
COMMIT;
