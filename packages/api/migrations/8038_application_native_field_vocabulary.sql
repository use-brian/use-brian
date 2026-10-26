BEGIN;
-- [COMP:api/application-records] Fixed codecs are inert data, never policy/SQL registration.
CREATE FUNCTION application_native_field_keys(p_type text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_type
 WHEN 'company' THEN ARRAY['name','domain','aliases','tags','externalRef','ownerId','archivedAt','createdAt','updatedAt']
 WHEN 'person' THEN ARRAY['name','email','phone','companyId','custom.organisation_name','custom.position','custom.mailing_address','aliases','tags','externalRef','ownerId','archivedAt','createdAt','updatedAt']
 WHEN 'deal' THEN ARRAY['name','stage','amount','companyId','contactId','closeDate','pipelineId','pipelineStageId','currencyCode','source','winLossReason','probability','aliases','tags','externalRef','ownerId','archivedAt','createdAt','updatedAt']
 WHEN 'task' THEN ARRAY['title','status'] WHEN 'file' THEN ARRAY['name','mimeType','sizeBytes','storageRef']
 WHEN 'workspace_member' THEN ARRAY['id'] ELSE '{}'::text[] END;
$$;
REVOKE ALL ON FUNCTION application_native_field_keys(text) FROM PUBLIC;
CREATE FUNCTION application_native_entity_values(p_type text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE values_json jsonb; attrs jsonb:=payload->'attributes';
BEGIN
 IF p_type NOT IN('company','person','deal') OR payload IS NULL THEN RETURN NULL;END IF;
 values_json:=jsonb_build_object('name',payload->'display_name','aliases',coalesce(payload->'aliases','[]'::jsonb),
  'tags',coalesce(attrs->'tags','[]'::jsonb),'externalRef',coalesce(attrs->'external_ref','{}'::jsonb),
  'ownerId',attrs->'owner_id','archivedAt',CASE WHEN attrs->>'crm_archived_at' IS NOT NULL THEN
    to_char((CASE WHEN length(attrs->>'crm_archived_at')=10 THEN (attrs->>'crm_archived_at')||'T00:00:00Z' ELSE attrs->>'crm_archived_at' END)::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'createdAt',to_char((payload->>'created_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char((payload->>'updated_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 IF p_type='company' THEN RETURN values_json||jsonb_build_object('domain',attrs->'domain');END IF;
 IF p_type='person' THEN RETURN values_json||jsonb_build_object('email',attrs->'email','phone',attrs->'phone','companyId',attrs->'company_id',
  'custom.organisation_name',attrs#>'{custom_fields,organisation_name}','custom.position',attrs#>'{custom_fields,position}',
  'custom.mailing_address',attrs#>'{custom_fields,mailing_address}');END IF;
 RETURN values_json||jsonb_build_object('stage',attrs->'stage','amount',attrs->>'amount','companyId',attrs->'company_id',
  'contactId',attrs->'contact_id','closeDate',attrs->'close_date','pipelineId',attrs->'pipeline_id','pipelineStageId',attrs->'pipeline_stage_id',
  'currencyCode',attrs->'currency_code','source',attrs->'source','winLossReason',attrs->'win_loss_reason','probability',attrs->'probability');
END $$;
REVOKE ALL ON FUNCTION application_native_entity_values(text,jsonb) FROM PUBLIC;

-- Both application and genuine native captures use exactly this canonical codec.
DO $migration$
DECLARE definition text; before text;
BEGIN
 SELECT pg_get_functiondef('public.application_native_projection(text,uuid,text,text[])'::regprocedure) INTO definition;
 before:=$source$WHEN 'company' THEN jsonb_build_object('name',payload->'display_name','domain',payload->'attributes'->'domain')
    WHEN 'person' THEN jsonb_build_object('name',payload->'display_name','email',payload->'attributes'->'email','phone',payload->'attributes'->'phone')
    WHEN 'deal' THEN jsonb_build_object('name',payload->'display_name','stage',payload->'attributes'->'stage','amount',payload->'attributes'->>'amount')$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native projection source changed; review fixed field codec';END IF;
 EXECUTE replace(definition,before,$source$WHEN 'company' THEN application_native_entity_values(type_key,payload)
    WHEN 'person' THEN application_native_entity_values(type_key,payload)
    WHEN 'deal' THEN application_native_entity_values(type_key,payload)$source$);
 SELECT pg_get_functiondef('public.application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure) INTO definition;
 before:=$source$values_json:=CASE p_type WHEN 'company' THEN jsonb_build_object('name',native_row->'display_name','domain',native_row#>'{attributes,domain}')
     WHEN 'person' THEN jsonb_build_object('name',native_row->'display_name','email',native_row#>'{attributes,email}','phone',native_row#>'{attributes,phone}')
     ELSE jsonb_build_object('name',native_row->'display_name','stage',native_row#>'{attributes,stage}','amount',native_row#>>'{attributes,amount}') END;$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native observation source changed; review fixed field codec';END IF;
 definition:=replace(definition,before,'values_json:=application_native_entity_values(p_type,native_row);');
 before:=$source$FROM unnest(p_fields) field WHERE NOT starts_with(field,'custom.');$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native metadata source changed; review fixed field identity';END IF;
 definition:=replace(definition,before,$source$FROM unnest(p_fields) field WHERE field=ANY(application_native_field_keys(p_type))
    AND NOT EXISTS(SELECT 1 FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL AND 'custom.'||f.field_key=field);$source$);
 -- Refuse undeclared fields even when a malformed native row carries an unknown key.
 before:=$source$SELECT coalesce(jsonb_agg(CASE WHEN p ? 'field_key'$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native identity source changed';END IF;
 definition:=replace(definition,before,$source$IF jsonb_array_length(metadata)<>cardinality(p_fields) THEN RETURN NULL;END IF;
  SELECT coalesce(jsonb_agg(CASE WHEN p ? 'field_key'$source$);
 EXECUTE definition;
END $migration$;

ALTER FUNCTION application_field_references(uuid,jsonb,text,jsonb) RENAME TO application_field_references_before_native_vocabulary;
REVOKE ALL ON FUNCTION application_field_references_before_native_vocabulary(uuid,jsonb,text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_field_references(w uuid,p_origin jsonb,p_type text,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb; field text; target_type text; cell jsonb;
BEGIN
 result:=application_field_references_before_native_vocabulary(w,p_origin,p_type,p_values);
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type IN('company','person','deal') THEN
  FOR field,target_type IN SELECT * FROM (VALUES('ownerId','workspace_member'),('companyId','company'),('contactId','person'),('pipelineId','crm_pipeline'),('pipelineStageId','crm_pipeline_stage')) known(field,type_key) LOOP
   IF NOT p_values ? field OR p_values->field='null'::jsonb THEN CONTINUE;END IF;
   cell:=p_values->field;
   IF jsonb_typeof(cell)<>'string' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   result:=result||jsonb_build_array(jsonb_build_object('origin',p_origin,'typeKey',target_type,'id',(cell#>>'{}')::uuid,'fields','[]'::jsonb));
  END LOOP;
 END IF;
 RETURN (SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') FROM (SELECT DISTINCT value FROM jsonb_array_elements(result)) refs);
END $$;
REVOKE ALL ON FUNCTION application_field_references(uuid,jsonb,text,jsonb) FROM PUBLIC;

-- Schema discovery reads structural source metadata, never business projections.
CREATE OR REPLACE FUNCTION application_native_catalog() RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; w uuid; candidate record; scope jsonb; decision jsonb; fields text[]; custom_fields jsonb;
 type_key text; source_kind text; owner_id uuid; record_id uuid; entries jsonb:='{}'; entry jsonb;
BEGIN
 context:=application_current_maxima();IF context IS NULL THEN RETURN;END IF;w:=(context->>'workspaceId')::uuid;
 FOR type_key IN SELECT DISTINCT m->'grants'->0->>'typeKey' FROM jsonb_array_elements(context->'layers') layer,
  LATERAL jsonb_array_elements(layer->'maxima') m WHERE m->'grants'->0->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
   AND m->'grants'->0->>'typeKey' IN('company','person','deal','task','file','workspace_member') LOOP
  fields:='{}';
  FOR candidate IN SELECT e.id,e.created_by_user_id AS owner_id FROM entities e WHERE e.workspace_id=w AND e.kind=type_key
   UNION ALL SELECT t.id,t.created_by_user_id FROM tasks t WHERE t.workspace_id=w AND type_key='task'
   UNION ALL SELECT f.id,NULL::uuid FROM workspace_files f WHERE f.workspace_id=w AND type_key='file'
   UNION ALL SELECT m.user_id,NULL::uuid FROM workspace_members m WHERE m.workspace_id=w AND type_key='workspace_member' LOOP
   record_id:=candidate.id;owner_id:=candidate.owner_id;
   source_kind:=CASE type_key WHEN 'task' THEN 'task' WHEN 'file' THEN 'workspace_file' WHEN 'workspace_member' THEN 'workspace_member' ELSE 'entity' END;
   IF scope_review_state_held(source_kind,record_id) OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=source_kind AND d.resource_id=record_id) THEN CONTINUE;END IF;
   scope:=CASE WHEN type_key='workspace_member' THEN application_reference_scope(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id)
    ||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL) ELSE read_scope_source(w,source_kind,record_id) END;
   IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' OR scope->>'validTo' IS NOT NULL OR scope->>'retractedAt' IS NOT NULL
    OR agent_visibility_allows(w,(scope->>'userId')::uuid,(scope->>'assistantId')::uuid) IS NOT TRUE THEN CONTINUE;END IF;
   decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id::text,owner_id,scope->>'sensitivity',
    ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid),(scope->>'userId')::uuid,'read');
   IF decision IS NOT NULL THEN fields:=fields||ARRAY(SELECT jsonb_array_elements_text(decision->'read'));END IF;
  END LOOP;
  IF context->>'readOnly'='false' THEN
   FOR candidate IN SELECT DISTINCT g.compartments,g.project_ids FROM jsonb_array_elements(context->'layers') layer,
    LATERAL jsonb_array_elements(layer->'maxima') m JOIN application_access_grants g ON g.id=(m->'grants'->0->>'id')::uuid
    WHERE g.app_id=(context->>'appId')::uuid AND g.resource_origin='{"kind":"native","moduleKey":"native"}'::jsonb
     AND g.resource_type=type_key AND g.selector->>'kind'='self' AND 'create'=ANY(g.actions) LOOP
    decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',type_key,'00000000-0000-4000-8000-000000000000',
     nullif(current_setting('app.current_user_id',true),'')::uuid,'public',candidate.compartments,candidate.project_ids,NULL,'create','{}'::jsonb);
    IF decision IS NOT NULL THEN fields:=fields||ARRAY(SELECT jsonb_array_elements_text((decision->'read')||(decision->'write')));END IF;
   END LOOP;
  END IF;
  fields:=ARRAY(SELECT DISTINCT field FROM unnest(fields) field WHERE field=ANY(application_native_field_keys(type_key))
    OR EXISTS(SELECT 1 FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=type_key AND f.archived_at IS NULL AND 'custom.'||f.field_key=field) ORDER BY field);
  IF cardinality(fields)=0 THEN CONTINUE;END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'entityKind',f.entity_kind,'fieldKey',f.field_key,'label',f.label,
   'fieldType',f.field_type,'options',f.options,'isRequired',f.is_required,'position',f.position) ORDER BY f.position,f.id),'[]') INTO custom_fields
   FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=type_key AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(fields);
  entries:=entries||jsonb_build_object(type_key,jsonb_build_object('typeKey',type_key,'fields',fields,'customFields',custom_fields));
 END LOOP;
 RETURN QUERY SELECT value FROM jsonb_each(entries) ORDER BY key;
END $$;
REVOKE ALL ON FUNCTION application_native_catalog() FROM PUBLIC;

-- This fixed nonowner port captures exact selected native values under the real SQL actor.
CREATE FUNCTION read_native_application_record(w uuid,p_type text,p_id uuid,p_fields text[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fields text[]:=p_fields; context jsonb; projected jsonb; state jsonb; captured jsonb; policy jsonb;
 origin jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF cardinality(application_native_field_keys(p_type))=0 THEN RETURN NULL;END IF;
 context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL AND context IS NULL THEN RETURN NULL;END IF;
 IF context IS NOT NULL AND context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;
 IF fields IS NULL THEN
  IF context IS NOT NULL THEN
   projected:=application_native_projection(p_type,p_id);IF projected IS NULL THEN RETURN NULL;END IF;
   fields:=ARRAY(SELECT jsonb_object_keys(projected->'values') ORDER BY 1);
  ELSE
   fields:=application_native_field_keys(p_type)||ARRAY(SELECT 'custom.'||f.field_key FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL);
   policy:=application_current_native_field_policy(w,origin,p_type,p_id);
   IF policy->>'registered'='true' THEN
    IF policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
    fields:=ARRAY(SELECT field FROM unnest(fields) field WHERE policy->'readFields' ? field);
   END IF;
  END IF;
 END IF;
 fields:=ARRAY(SELECT DISTINCT field FROM unnest(fields) field ORDER BY field);
 IF p_fields IS NOT NULL AND cardinality(fields)<>cardinality(p_fields) THEN RETURN NULL;END IF;
 state:=application_field_projection_state(w,origin,p_type,p_id,'read',NULL,fields);
 IF state IS NULL THEN RETURN NULL;END IF;
 captured:=observe_application_field_projection(w,origin,p_type,p_id,state->>'recordVersion','read',NULL,fields);
 IF captured IS NULL OR captured->'values' IS DISTINCT FROM state->'values' THEN RETURN NULL;END IF;
 RETURN captured||jsonb_build_object('id',p_id,'recordVersion',state->>'recordVersion');
END $$;
REVOKE ALL ON FUNCTION read_native_application_record(uuid,text,uuid,text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_native_application_record(uuid,text,uuid,text[]) TO app_user;
 END IF;
END $$;
COMMIT;
