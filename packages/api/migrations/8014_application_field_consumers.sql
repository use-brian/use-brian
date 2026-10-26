-- Actual module field roles participate in canonical field observations.
-- Native capture/current-read integration; runtime qualification remains closed.
-- [COMP:api/application-field-evidence] [COMP:security/native-field-policy]
BEGIN;

-- One validated deployed metadata dictionary for native/app/issuer field masks.
-- Private dictionaries and role masks are restrictions, never row/source grants.
CREATE FUNCTION application_native_field_contract_for(w uuid,p_origin jsonb,p_type text,p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical_origin jsonb:=p_origin; canonical_type text:=p_type; contract application_native_field_contracts;
 namespace text; procedure_name text; metadata jsonb; source jsonb; keys text[]; field jsonb; profile jsonb; fingerprint text;
BEGIN
 IF p_origin->>'kind'='generic' THEN
  IF p_origin-ARRAY['kind','entityTypeId']<>'{}'::jsonb THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  canonical_origin:=jsonb_build_object('kind','generic','entityTypeId',((p_origin->>'entityTypeId')::uuid)::text);
  canonical_type:='record.'||(canonical_origin->>'entityTypeId');
 END IF;
 SELECT c.* INTO contract FROM application_native_resource_owners o JOIN application_native_field_contracts c USING(module_key)
  WHERE o.workspace_id=w AND o.origin=canonical_origin AND o.resource_type=canonical_type;
 IF NOT FOUND THEN RETURN '{"registered":false}'::jsonb; END IF;
 IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 256 THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=contract.metadata_reader;
 IF namespace IS NULL THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 EXECUTE format('SELECT %I.%I($1,$2,$3,$4)',namespace,procedure_name) INTO metadata USING w,canonical_origin,canonical_type,p_id;
 IF jsonb_typeof(metadata) IS DISTINCT FROM 'object'
  OR NOT metadata ?& ARRAY['moduleKey','origin','typeKey','schemaVersion','policyVersion','recordVersion','fieldKeys','fields','source']
  OR metadata-ARRAY['moduleKey','origin','typeKey','schemaVersion','policyVersion','recordVersion','fieldKeys','fields','source']<>'{}'::jsonb
  OR metadata->>'moduleKey' IS DISTINCT FROM contract.module_key OR metadata->'origin' IS DISTINCT FROM canonical_origin
  OR metadata->>'typeKey' IS DISTINCT FROM canonical_type OR jsonb_typeof(metadata->'recordVersion') IS DISTINCT FROM 'string'
  OR length(metadata->>'recordVersion') NOT BETWEEN 1 AND 256
  OR jsonb_typeof(metadata->'schemaVersion') IS DISTINCT FROM 'string' OR jsonb_typeof(metadata->'policyVersion') IS DISTINCT FROM 'string'
  OR length(metadata->>'schemaVersion') NOT BETWEEN 1 AND 128 OR length(metadata->>'policyVersion') NOT BETWEEN 1 AND 128
  OR jsonb_typeof(metadata->'fieldKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(metadata->'fields') IS DISTINCT FROM 'array'
  OR jsonb_array_length(metadata->'fieldKeys')>128 OR jsonb_array_length(metadata->'fields')<>jsonb_array_length(metadata->'fieldKeys')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(metadata->'fieldKeys') item WHERE jsonb_typeof(item)<>'string' OR length(item#>>'{}') NOT BETWEEN 1 AND 128
   OR item#>>'{}'=ANY(ARRAY['__proto__','prototype','constructor'])) THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 keys:=ARRAY(SELECT jsonb_array_elements_text(metadata->'fieldKeys'));
 IF cardinality(keys)<>(SELECT count(DISTINCT field_key) FROM unnest(keys) field_key)
  OR cardinality(keys)<>(SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(metadata->'fields')) THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 source:=metadata->'source';
 IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR source->>'workspaceId' IS DISTINCT FROM w::text
  OR source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL
  OR source->>'version' IS DISTINCT FROM metadata->>'recordVersion' OR entity_derivation_envelope_valid(source) IS NOT TRUE
  THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 FOR field IN SELECT value FROM jsonb_array_elements(metadata->'fields') LOOP
  IF jsonb_typeof(field) IS DISTINCT FROM 'object' OR NOT field ?& ARRAY['key','read','write','releaseReadTo','releaseWriteTo']
   OR field-ARRAY['key','read','write','releaseReadTo','releaseWriteTo']<>'{}'::jsonb OR jsonb_typeof(field->'key') IS DISTINCT FROM 'string'
   OR NOT coalesce(field->>'key'=ANY(keys),false)
   OR application_native_field_rule_valid(field->'read',contract.role_keys) IS NOT TRUE
   OR application_native_field_rule_valid(field->'write',contract.role_keys) IS NOT TRUE THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  FOR profile IN SELECT value FROM jsonb_array_elements(jsonb_build_array(field->'releaseReadTo',field->'releaseWriteTo')) LOOP
   IF jsonb_typeof(profile) IS DISTINCT FROM 'array' OR jsonb_array_length(profile)>2
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(profile) item WHERE item NOT IN('"external_user"'::jsonb,'"service"'::jsonb))
    OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(profile)) THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  END LOOP;
 END LOOP;
 fingerprint:=application_field_digest(jsonb_build_object('contract',contract.contract_version,'roles',contract.role_keys,
  'schema',metadata->'schemaVersion','policy',metadata->'policyVersion','fields',metadata->'fields'));
 RETURN jsonb_build_object('registered',true,'held',false,'metadata',metadata,'roleKeys',contract.role_keys,'fingerprint',fingerprint);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow
 OR undefined_function OR undefined_table OR insufficient_privilege THEN RETURN '{"registered":true,"held":true}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION application_native_field_contract_for(uuid,jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION application_native_member_field_permissions(w uuid,policy jsonb,member_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE roles text[]; field jsonb; readable text[]:='{}'; writable text[]:='{}'; metadata jsonb:=policy->'metadata';
BEGIN
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=member_id) THEN RETURN NULL; END IF;
 SELECT coalesce(array_agg(DISTINCT a.role_key),'{}') INTO roles FROM application_native_role_assignments a
  WHERE a.workspace_id=w AND a.module_key=metadata->>'moduleKey' AND a.user_id=member_id AND a.status='active'
   AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()) AND (policy->'roleKeys') ? a.role_key;
 FOR field IN SELECT value FROM jsonb_array_elements(metadata->'fields') LOOP
  IF application_native_field_rule_allows(field->'read',roles) THEN readable:=readable||(field->>'key'); END IF;
  IF application_native_field_rule_allows(field->'write',roles) THEN writable:=writable||(field->>'key'); END IF;
 END LOOP;
 RETURN jsonb_build_object('read',ARRAY(SELECT unnest(readable) ORDER BY 1),'write',ARRAY(SELECT unnest(writable) ORDER BY 1));
END $$;
REVOKE ALL ON FUNCTION application_native_member_field_permissions(uuid,jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION application_native_nonmember_field_permissions(policy jsonb,profile text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field jsonb; readable text[]:='{}'; writable text[]:='{}';
BEGIN
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR profile IS NULL OR profile NOT IN('external_user','service') THEN RETURN NULL; END IF;
 FOR field IN SELECT value FROM jsonb_array_elements(policy#>'{metadata,fields}') LOOP
  IF (field->'releaseReadTo') ? profile THEN readable:=readable||(field->>'key'); END IF;
  IF (field->'releaseWriteTo') ? profile THEN writable:=writable||(field->>'key'); END IF;
 END LOOP;
 RETURN jsonb_build_object('read',ARRAY(SELECT unnest(readable) ORDER BY 1),'write',ARRAY(SELECT unnest(writable) ORDER BY 1));
END $$;
REVOKE ALL ON FUNCTION application_native_nonmember_field_permissions(jsonb,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION read_native_application_field_mask(w uuid,p_origin jsonb,p_type text,p_id text,p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; policy jsonb; metadata jsonb; source jsonb; permissions jsonb; can_write boolean;
BEGIN
 IF actor IS NULL OR p_id IS NULL OR p_version IS NULL OR length(p_id) NOT BETWEEN 1 AND 256 OR length(p_version) NOT BETWEEN 1 AND 256
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.application_native_field_contracts'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
   OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN RETURN NULL; END IF;
 policy:=application_native_field_contract_for(w,p_origin,p_type,p_id);
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
 metadata:=policy->'metadata';source:=metadata->'source';
 IF metadata->>'recordVersion' IS DISTINCT FROM p_version
  OR agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN RETURN NULL; END IF;
 permissions:=application_native_member_field_permissions(w,policy,actor);
 IF permissions IS NULL THEN RETURN NULL; END IF;
 can_write:=member_operation_row_allows(member_principal_operation_grants(actor,true,w),w,source->>'sensitivity',
  ARRAY(SELECT jsonb_array_elements_text(source->'compartments')))
  AND agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(source->'compartments')));
 RETURN jsonb_build_object('moduleKey',metadata->'moduleKey','schemaVersion',metadata->'schemaVersion','recordVersion',p_version,
  'policyVersion',policy->'fingerprint','readFields',permissions->'read','writeFields',CASE WHEN can_write THEN permissions->'write' ELSE '[]'::jsonb END);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow
 OR undefined_function OR undefined_table OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION read_native_application_field_mask(uuid,jsonb,text,text,text) FROM PUBLIC;

ALTER FUNCTION application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb)
 RENAME TO application_path_fields_before_module_policy;
REVOKE ALL ON FUNCTION application_path_fields_before_module_policy(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_path_fields(maximum jsonb,subject jsonb,w uuid,origin jsonb,type_key text,record_id text,owner_id uuid,
 tier text,teams text[],projects uuid[],row_user uuid,action text,prospective_data jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE decision jsonb; policy jsonb; issued jsonb; current_grant application_access_grants; issuer_mask jsonb; principal_mask jsonb;
BEGIN
 decision:=application_path_fields_before_module_policy(maximum,subject,w,origin,type_key,record_id,owner_id,tier,teams,projects,row_user,action,prospective_data);
 IF decision IS NULL THEN RETURN NULL; END IF;
 policy:=application_native_field_contract_for(w,origin,type_key,record_id);
 IF policy->>'registered'='false' THEN RETURN decision; END IF;
 IF policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
 FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
  SELECT * INTO current_grant FROM application_access_grants g WHERE g.id=(issued->>'id')::uuid
   AND g.workspace_id=w AND g.app_id=(application_current_maxima()->>'appId')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  issuer_mask:=application_native_member_field_permissions(w,policy,current_grant.issued_by_user_id);
  principal_mask:=CASE WHEN current_grant.principal_kind='member'
   THEN application_native_member_field_permissions(w,policy,current_grant.principal_user_id)
   ELSE application_native_nonmember_field_permissions(policy,current_grant.principal_kind) END;
  IF issuer_mask IS NULL OR principal_mask IS NULL THEN RETURN NULL; END IF;
  decision:=jsonb_build_object('read',ARRAY(SELECT jsonb_array_elements_text(decision->'read')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'read') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'read')),
   'write',ARRAY(SELECT jsonb_array_elements_text(decision->'write')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'write') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'write')));
 END LOOP;
 RETURN decision;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;

-- Private current-fact port, never a payload reader, receipt or write permit.
CREATE FUNCTION application_current_native_field_policy(w uuid,p_origin jsonb,p_type text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb; metadata jsonb; decision jsonb;
BEGIN
 policy:=application_native_field_contract_for(w,p_origin,p_type,p_id::text);
 IF policy->>'registered'='false' OR policy->>'held' IS DISTINCT FROM 'false' THEN RETURN policy; END IF;
 metadata:=policy->'metadata';
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  -- This dictionary does not admit an app. The canonical projection below must
  -- still pass application_path_fields, including each issuer/parent field mask.
  IF application_current_maxima() IS NULL THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  RETURN jsonb_build_object('registered',true,'held',false,'moduleKey',metadata->'moduleKey',
   'recordVersion',metadata->'recordVersion','schemaVersion',metadata->'schemaVersion',
   'policyVersion',policy->'fingerprint','readFields',metadata->'fieldKeys');
 END IF;
 decision:=read_native_application_field_mask(w,p_origin,p_type,p_id::text,metadata->>'recordVersion');
 IF decision IS NULL THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 RETURN decision||'{"registered":true,"held":false}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION application_current_native_field_policy(uuid,jsonb,text,uuid) FROM PUBLIC;

ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])
 RENAME TO application_field_projection_state_before_module_policy;
REVOKE ALL ON FUNCTION application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

-- Native generic absence is an observation only after declared-field and row admission.
-- Preserve the presence whitelist for built-in native and application projections.
CREATE OR REPLACE FUNCTION application_field_projection_state_before_module_policy(w uuid,p_origin jsonb,p_type text,p_id uuid,
 p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; origin_kind text:=p_origin->>'kind'; action text;
 kind text; native_row jsonb; projected jsonb; scope jsonb; values_json jsonb;
 metadata jsonb; identity_metadata jsonb; property jsonb; custom record; cell jsonb;
 generic_type uuid; version text; owner uuid; reference jsonb; candidate record;
BEGIN
 IF p_selection NOT IN('read','query','history','identity') OR p_fields IS NULL
  OR cardinality(p_fields)>256 OR array_position(p_fields,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(p_fields) field WHERE length(field) NOT BETWEEN 1 AND 256)
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field)
  OR (p_selection='history') IS DISTINCT FROM (p_selected_version IS NOT NULL) THEN RETURN NULL; END IF;
 action:=CASE p_selection WHEN 'identity' THEN 'read' ELSE p_selection END;
 context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL AND context IS NULL THEN RETURN NULL; END IF;
 IF context IS NOT NULL AND context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN NULL; END IF;
 IF origin_kind='generic' AND p_origin-ARRAY['kind','entityTypeId']='{}'::jsonb THEN
  generic_type:=(p_origin->>'entityTypeId')::uuid;kind:='entity_instance';p_type:='record.'||generic_type;
  SELECT to_jsonb(r) INTO native_row FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=generic_type AND r.id=p_id;
  IF native_row IS NULL OR scope_review_state_held(kind,p_id) THEN RETURN NULL; END IF;
  owner:=(native_row->>'created_by')::uuid;
  SELECT coalesce(jsonb_agg(p ORDER BY p->>'name'),'[]'::jsonb) INTO metadata
   FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p WHERE t.id=generic_type AND t.workspace_id=w AND p->>'name'=ANY(p_fields);
  IF jsonb_array_length(metadata)<>cardinality(p_fields) THEN RETURN NULL; END IF;
  IF context IS NOT NULL THEN
   -- Canonical generic identity is reader independent. Each app resolves an
   -- actually admitted catalog alias from its own current maxima, never the
   -- original reader's app/grant/type alias.
   FOR candidate IN SELECT DISTINCT m->'grants'->0->>'typeKey' AS type_key
    FROM jsonb_array_elements(context->'layers') layer,LATERAL jsonb_array_elements(layer->'maxima') m
    WHERE m->'grants'->0->'origin'=p_origin ORDER BY type_key LOOP
    BEGIN
     IF p_selection='history' THEN
      SELECT to_jsonb(p) INTO projected FROM application_generic_history(generic_type,candidate.type_key,p_id,p_selected_version::bigint+1,1) p
       WHERE p.record_version::text=p_selected_version;
     ELSE
      SELECT to_jsonb(p) INTO projected FROM application_generic_projection(generic_type,candidate.type_key,action,p_id,p_fields) p;
     END IF;
    EXCEPTION WHEN insufficient_privilege THEN projected:=NULL;
    END;
    EXIT WHEN projected IS NOT NULL;
   END LOOP;
   IF projected IS NULL THEN RETURN NULL; END IF;
   values_json:=projected->'data';scope:=(projected->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);version:=projected->>'record_version';
  ELSE
   scope:=read_admitted_native_scope_snapshot(w,kind,p_id);
   IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
   version:=native_row->>'record_version';values_json:=native_row->'data';
   IF p_selection='history' THEN
    SELECT to_jsonb(h) INTO projected FROM application_record_revisions h
     WHERE h.workspace_id=w AND h.entity_instance_id=p_id AND h.record_version::text=p_selected_version;
    IF projected IS NULL THEN RETURN NULL; END IF;
    scope:=scope||jsonb_build_object('sensitivity',projected->'sensitivity','compartments',projected->'compartments','projectIds',projected->'project_ids');
    IF workflow_evidence_envelope_visible(w,scope) IS NOT TRUE THEN RETURN NULL; END IF;
    values_json:=projected->'data';version:=p_selected_version;
   ELSE
    -- Materialized system cells use the canonical row metadata, never user data.
    FOR property IN SELECT value FROM jsonb_array_elements(metadata) LOOP
     cell:=NULL;
     CASE property->'config'->>'kind'
      WHEN 'created_time' THEN cell:=native_row->'created_at';
      WHEN 'last_edited_time' THEN cell:=native_row->'last_edited_at';
      WHEN 'created_by' THEN cell:=coalesce(native_row->'created_by','null'::jsonb);
      WHEN 'last_edited_by' THEN cell:=coalesce(native_row->'last_edited_by','null'::jsonb);
      ELSE NULL;
     END CASE;
     IF cell IS NOT NULL THEN values_json:=values_json||jsonb_build_object(property->>'name',jsonb_build_object('kind',property->'config'->>'kind','value',cell)); END IF;
    END LOOP;
   END IF;
  END IF;
  -- Display labels can change without replacing a canonical field identity.
  SELECT coalesce(jsonb_agg(jsonb_build_object('key',p->'name','kind',p#>'{config,kind}','target',p#>'{config,targetEntityTypeRef}') ORDER BY p->>'name'),'[]')
   INTO identity_metadata FROM jsonb_array_elements(metadata) p;
 ELSIF p_origin=jsonb_build_object('kind','native','moduleKey','native') AND p_type IN('company','person','deal','task','file','workspace_member') THEN
  IF p_selection='history' THEN RETURN NULL; END IF;
  kind:=CASE p_type WHEN 'task' THEN 'task' WHEN 'file' THEN 'workspace_file' WHEN 'workspace_member' THEN 'workspace_member' ELSE 'entity' END;
  IF context IS NOT NULL THEN
   projected:=application_native_projection(p_type,p_id,action,p_fields);
   IF projected IS NULL THEN RETURN NULL; END IF;
   values_json:=projected->'values';scope:=projected->'source';version:=scope->>'version';
  ELSE
   scope:=read_admitted_native_scope_snapshot(w,kind,p_id);
   IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' OR scope->>'validTo' IS NOT NULL OR scope->>'retractedAt' IS NOT NULL THEN RETURN NULL; END IF;
   IF p_type='workspace_member' THEN
    native_row:=jsonb_build_object('id',p_id);values_json:=native_row;
   ELSIF p_type='file' THEN
    SELECT to_jsonb(f) INTO native_row FROM workspace_files f WHERE f.workspace_id=w AND f.id=p_id;
    values_json:=jsonb_build_object('name',native_row->'name','mimeType',native_row->'mime','sizeBytes',native_row->'size_bytes','storageRef',native_row->'storage_uri');
   ELSIF p_type='task' THEN
    SELECT to_jsonb(t) INTO native_row FROM tasks t WHERE t.workspace_id=w AND t.id=p_id;
    values_json:=jsonb_build_object('title',native_row->'title','status',native_row->'status');
   ELSE
    SELECT to_jsonb(e) INTO native_row FROM entities e WHERE e.workspace_id=w AND e.id=p_id AND e.kind=p_type;
    values_json:=CASE p_type WHEN 'company' THEN jsonb_build_object('name',native_row->'display_name','domain',native_row#>'{attributes,domain}')
     WHEN 'person' THEN jsonb_build_object('name',native_row->'display_name','email',native_row#>'{attributes,email}','phone',native_row#>'{attributes,phone}')
     ELSE jsonb_build_object('name',native_row->'display_name','stage',native_row#>'{attributes,stage}','amount',native_row#>'{attributes,amount}') END;
    FOR custom IN SELECT f.* FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type
     AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(p_fields) LOOP
     values_json:=values_json||jsonb_build_object('custom.'||custom.field_key,coalesce(native_row->'attributes'->'custom_fields'->custom.field_key,'null'::jsonb));
    END LOOP;
   END IF;
   IF native_row IS NULL THEN RETURN NULL; END IF;
   version:=scope->>'version';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('key',field,'kind','builtin','version',1) ORDER BY field),'[]') INTO metadata
   FROM unnest(p_fields) field WHERE NOT starts_with(field,'custom.');
  SELECT metadata||coalesce(jsonb_agg(to_jsonb(f)-ARRAY['label','position','created_at','updated_at'] ORDER BY f.field_key),'[]') INTO metadata
   FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(p_fields);
  SELECT coalesce(jsonb_agg(CASE WHEN p ? 'field_key' THEN jsonb_build_object('id',p->'id','key',p->'field_key','kind',p->'field_type') ELSE p END
   ORDER BY coalesce(p->>'key',p->>'field_key')),'[]') INTO identity_metadata FROM jsonb_array_elements(metadata) p;
  IF native_row IS NULL THEN
   IF p_type='task' THEN SELECT to_jsonb(t) INTO native_row FROM tasks t WHERE t.workspace_id=w AND t.id=p_id;
   ELSIF p_type IN('company','person','deal') THEN SELECT to_jsonb(e) INTO native_row FROM entities e WHERE e.workspace_id=w AND e.id=p_id AND e.kind=p_type; END IF;
  END IF;
  owner:=(native_row->>'created_by_user_id')::uuid;
 ELSE RETURN NULL;
 END IF;
 IF scope IS NULL OR scope->>'workspaceId' IS DISTINCT FROM w::text OR scope->>'held' IS DISTINCT FROM 'false'
  OR version IS NULL OR ((origin_kind<>'generic' OR p_selection='history') AND NOT to_jsonb(p_fields)<@coalesce((SELECT jsonb_agg(key) FROM jsonb_object_keys(values_json) key),'[]')) THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO values_json FROM jsonb_each(values_json) WHERE key=ANY(p_fields);
 -- Reference discovery/admission uses original returned values, never a later
 -- target selected from changed business data. Only opaque canonical refs persist.
 FOR reference IN SELECT value FROM jsonb_array_elements(application_field_references(w,p_origin,p_type,values_json)) LOOP
  IF application_field_reference_admitted(w,reference) IS NOT TRUE THEN RETURN NULL; END IF;
 END LOOP;
 RETURN jsonb_build_object('values',values_json,'source',scope,'recordVersion',version,'sourceKind',kind,'sourceId',p_id,
  'sourceVersion',CASE WHEN p_selection='history' THEN p_selected_version ELSE scope->>'version' END,'ownerId',owner,
  'fieldIdentity',application_field_digest(jsonb_build_object('origin',p_origin,'type',p_type,'fields',identity_metadata)),
  'policyVersion',application_field_digest(metadata),'references',application_field_references(w,p_origin,p_type,values_json));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow OR insufficient_privilege THEN RETURN NULL;
END $$;

CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,
 p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb; state jsonb;
BEGIN
 policy:=application_current_native_field_policy(w,p_origin,p_type,p_id);
 IF policy->>'registered'='true' AND (policy->>'held' IS DISTINCT FROM 'false'
  OR p_fields IS NULL OR NOT to_jsonb(p_fields)<@(policy->'readFields')) THEN RETURN NULL; END IF;
 state:=application_field_projection_state_before_module_policy(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
 IF state IS NULL THEN RETURN NULL; END IF;
 IF policy->>'registered'='true' THEN
  IF p_selection<>'history' AND state->>'recordVersion' IS DISTINCT FROM policy->>'recordVersion' THEN RETURN NULL; END IF;
  state:=state||jsonb_build_object('policyVersion',application_field_digest(jsonb_build_object(
   'fieldPolicy',state->'policyVersion','modulePolicy',policy->'policyVersion')));
 END IF;
 RETURN state;
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

-- The observation identity uses the canonical generic UUID, including recursive
-- reference captures; spelling and app catalog aliases are never owners/grants.
ALTER FUNCTION application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)
 RENAME TO application_compute_field_envelope_before_module_policy;
REVOKE ALL ON FUNCTION application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer) FROM PUBLIC;
CREATE FUNCTION application_compute_field_envelope(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,
 p_selected_version text,p_fields text[],depth integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin->>'kind'='generic' THEN
  IF p_origin-ARRAY['kind','entityTypeId']<>'{}'::jsonb THEN RETURN NULL; END IF;
  p_origin:=jsonb_build_object('kind','generic','entityTypeId',((p_origin->>'entityTypeId')::uuid)::text);
  p_type:='record.'||(p_origin->>'entityTypeId');
 END IF;
 RETURN application_compute_field_envelope_before_module_policy(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields,depth);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer) FROM PUBLIC;

CREATE FUNCTION read_generic_application_record(w uuid,p_type uuid,p_alias text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; source jsonb; context jsonb;
 policy jsonb; selected text[]; record_version text; captured jsonb; projected record; canonical entity_instances;
 origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type);
BEGIN
 IF actor IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_instances'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  source:=read_admitted_native_scope_snapshot(w,'entity_instance',p_id);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT r.record_version::text INTO record_version FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=p_type AND r.id=p_id;
  IF record_version IS NULL OR record_version IS DISTINCT FROM source->>'version' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  policy:=application_current_native_field_policy(w,origin,p_alias,p_id);
  IF policy->>'registered'='true' THEN
   IF policy->>'held' IS DISTINCT FROM 'false' OR policy->>'recordVersion' IS DISTINCT FROM record_version THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
   selected:=ARRAY(SELECT jsonb_array_elements_text(policy->'readFields'));
  ELSE
   SELECT ARRAY(SELECT p->>'name' FROM jsonb_array_elements(t.properties) p ORDER BY p->>'name') INTO selected
    FROM entity_types t WHERE t.workspace_id=w AND t.id=p_type;
  END IF;
 ELSE
  context:=application_current_maxima();
  IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT p.data,p.record_version::text,p.source INTO projected FROM application_generic_projection(p_type,p_alias,'read',p_id) p;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO canonical FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=p_type AND r.id=p_id;
  IF NOT FOUND OR canonical.record_version::text IS DISTINCT FROM projected.record_version THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  record_version:=projected.record_version;
  policy:=application_resource_fields(w,origin,p_alias,p_id::text,canonical.created_by,canonical.sensitivity,canonical.compartments,canonical.project_ids,NULL,'read');
  IF policy IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  -- Do not classify a withheld relation/system cell as an observed absence.
  SELECT ARRAY(SELECT p->>'name' FROM jsonb_array_elements(t.properties) p
    WHERE (policy->'read') ? (p->>'name') AND (projected.data ? (p->>'name')
     OR NOT canonical.data ? (p->>'name') AND p#>>'{config,kind}' NOT IN('created_time','last_edited_time','created_by','last_edited_by')) ORDER BY p->>'name')
   INTO selected FROM entity_types t WHERE t.workspace_id=w AND t.id=p_type;
 END IF;
 IF selected IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 captured:=observe_application_field_projection(w,origin,p_alias,p_id,record_version,'read',NULL,selected);
 RETURN captured||jsonb_build_object('id',p_id,'recordVersion',record_version,
  'absentFields',ARRAY(SELECT field FROM unnest(selected) field WHERE NOT (captured->'values') ? field ORDER BY field));
END $$;
REVOKE ALL ON FUNCTION read_generic_application_record(uuid,uuid,text,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_generic_application_record(uuid,uuid,text,uuid) TO app_user;
  REVOKE ALL ON FUNCTION application_native_field_contract_for(uuid,jsonb,text,text),
   application_native_member_field_permissions(uuid,jsonb,uuid),application_native_nonmember_field_permissions(jsonb,text),
   application_path_fields_before_module_policy(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb),
   application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM app_user;
  REVOKE ALL ON FUNCTION application_current_native_field_policy(uuid,jsonb,text,uuid),
   application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]),
   application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[]),
   application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer),
   application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer) FROM app_user;
 END IF;
END $$;
COMMIT;
