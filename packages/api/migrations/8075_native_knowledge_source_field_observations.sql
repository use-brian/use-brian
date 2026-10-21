BEGIN;
-- [COMP:api/application-persistence] Selected native Knowledge source-card fields.
-- The existing admitted snapshot still owns its full validation. Its native
-- parent dispatcher did not yet recognize configured Knowledge source bindings.
-- Add that typed metadata parent; delegate every other native kind unchanged.
ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_knowledge_source_parent;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;root jsonb;policy jsonb;dependency jsonb;admitted jsonb;required jsonb:='[]';
BEGIN
 IF k<>'knowledge_source' THEN RETURN read_entity_derivation_source_before_knowledge_source_parent(w,k,i);END IF;
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)<>w::text
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.workspace_knowledge_sources'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 root:=read_scope_source(w,k,i);
 IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' OR root->>'version' IS NULL
  OR root->>'validTo' IS NOT NULL OR root->>'retractedAt' IS NOT NULL
  OR entity_derivation_envelope_valid(root) IS NOT TRUE OR scope_review_state_held(k,i)
  OR agent_visibility_allows(w,(root->>'userId')::uuid,(root->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,root) IS NOT TRUE THEN RETURN NULL;END IF;
 policy:=application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_source');
 IF policy->>'registered' IS DISTINCT FROM 'false' AND (policy->>'held' IS DISTINCT FROM 'false'
  OR read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','knowledge_source') IS NULL) THEN RETURN NULL;END IF;
 -- Current Page obligations use the original canonical dependency readers.
 FOR dependency IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies(w,k,i,root->>'version')) LOOP
  admitted:=read_page_derivation_source(w,dependency->>'resourceKind',(dependency->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM dependency->>'version' THEN RETURN NULL;END IF;
  required:=required||jsonb_build_array(dependency)||coalesce(admitted->'requiredSources','[]');
 END LOOP;
 RETURN root||jsonb_build_object('requiredSources',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(required)));
END $$;
REVOKE ALL ON FUNCTION read_entity_derivation_source(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_knowledge_source_field_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT ARRAY['id','sourceType','repo','branch','rootPath','lastSyncedAt']::text[]
$$;
REVOKE ALL ON FUNCTION application_knowledge_source_field_keys() FROM PUBLIC;

CREATE FUNCTION application_knowledge_source_field_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 source jsonb;bounds jsonb;policy jsonb;catalog jsonb;mask jsonb;definition_fields jsonb;keys text[];field text;value jsonb;values_json jsonb:='{}';
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.workspace_knowledge_sources'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 IF fields IS NULL OR NOT fields<@application_knowledge_source_field_keys() OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR coalesce(nullif(current_setting('app.native_query_data_ceilings',true),'')::jsonb,'[]'::jsonb)<>'[]'::jsonb THEN RETURN NULL;END IF;
 bounds:=application_native_query_bounds(w);IF bounds IS NULL OR application_query_scope_valid(bounds) IS NOT TRUE THEN RETURN NULL;END IF;
 source:=read_admitted_native_scope_snapshot(w,'knowledge_source',i);
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS NULL
  OR application_query_scope_admits_point(bounds,source) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'knowledge_source',i,source->>'version') IS NOT TRUE THEN RETURN NULL;END IF;
 keys:=ARRAY(SELECT key FROM unnest(application_knowledge_source_field_keys()) key ORDER BY key);
 catalog:=application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_source');
 policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_source',i::text);
 IF catalog->>'registered'='false' AND policy->>'registered'='false' THEN
  SELECT jsonb_agg(jsonb_build_object('key',key,'read','[]'::jsonb,'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key)
   INTO definition_fields FROM unnest(keys) key;
  -- Public schema metadata grants no data scope. The actual configured source
  -- above must exist and pass its current complete canonical scope/ancestry.
  catalog:=jsonb_build_object('registered',true,'held',false,'roleKeys','[]'::jsonb,
   'metadata',jsonb_build_object('moduleKey','native','origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey','knowledge_source',
    'schemaVersion','knowledge-source-fields-v1','policyVersion','knowledge-source-fields-v1','fieldKeys',keys,'fields',definition_fields,
    'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)),
   'fingerprint',application_field_digest(jsonb_build_object('kind','knowledge-source-fields-v1','fields',definition_fields)));
  mask:=application_native_member_field_permissions(w,catalog,actor);
 ELSE
  IF catalog->>'registered' IS DISTINCT FROM 'true' OR catalog->>'held' IS DISTINCT FROM 'false'
   OR policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR policy#>>'{metadata,recordVersion}' IS DISTINCT FROM source->>'version'
   OR NOT coalesce(to_jsonb(keys)<@(catalog#>'{metadata,fieldKeys}'),false) THEN RETURN NULL;END IF;
  mask:=read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','knowledge_source');
  IF NOT coalesce(to_jsonb(fields)<@(mask->'readFields'),false) THEN RETURN NULL;END IF;
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','knowledge_source',i::text,source->>'version');
  mask:=jsonb_build_object('read',mask->'readFields');
 END IF;
 IF workflow_evidence_envelope_visible(w,catalog#>'{metadata,scope}') IS NOT TRUE
  OR NOT coalesce(to_jsonb(fields)<@(mask->'read'),false) THEN RETURN NULL;END IF;
 -- No source location or sync value is selected or hashed before admission.
 FOREACH field IN ARRAY fields LOOP
  EXECUTE format('SELECT to_jsonb(%I) FROM public.workspace_knowledge_sources WHERE workspace_id=$1 AND id=$2 AND binding_version::text=$3',
   CASE field WHEN 'sourceType' THEN 'source_type' WHEN 'rootPath' THEN 'root_path' WHEN 'lastSyncedAt' THEN 'last_synced_at' ELSE field END)
   INTO value USING w,i,source->>'version';
  values_json:=values_json||jsonb_build_object(field,value);
 END LOOP;
 source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
  'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind','knowledge_source','resourceId',i,'version',source->'version');
 RETURN jsonb_build_object('values',values_json,'source',source,
  'recordVersion',(source->>'version')||':'||application_field_digest(values_json),'sourceKind','knowledge_source','sourceId',i,'sourceVersion',source->'version','ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','knowledge-source-fields-v1','fields',fields,'valueRevision',application_field_digest(values_json))),
  'policyVersion',application_field_digest(jsonb_build_object('kind','knowledge-source-fields-v1','fields',fields,'catalog',catalog->'fingerprint','record',policy->'fingerprint')),
  'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_knowledge_source_field_state(uuid,uuid,text[]) FROM PUBLIC;

ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_knowledge_source;
REVOKE ALL ON FUNCTION application_field_projection_state_before_knowledge_source(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='knowledge_source' THEN
  IF p_selected_version IS NOT NULL OR p_selection NOT IN('read','identity') THEN RETURN NULL;END IF;
  RETURN application_knowledge_source_field_state(w,p_id,p_fields);
 END IF;
 RETURN application_field_projection_state_before_knowledge_source(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

CREATE FUNCTION read_native_knowledge_source_projection(w uuid,i uuid,expected_binding_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fields text[];state jsonb;captured jsonb;
BEGIN
 IF expected_binding_version IS NULL THEN RETURN NULL;END IF;
 fields:=ARRAY(SELECT field FROM unnest(application_knowledge_source_field_keys()) field ORDER BY field);
 state:=application_knowledge_source_field_state(w,i,fields);
 IF state IS NULL OR state->>'sourceVersion' IS DISTINCT FROM expected_binding_version THEN RETURN NULL;END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','knowledge_source',i,state->>'recordVersion','read',NULL,fields);
 IF captured IS NULL THEN RETURN NULL;END IF;
 RETURN captured||jsonb_build_object('source',state->'source','recordVersion',state->'recordVersion');
END $$;
REVOKE ALL ON FUNCTION read_native_knowledge_source_projection(uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_native_knowledge_source_projection(uuid,uuid,text) TO app_user;
END IF;END $$;
COMMIT;
