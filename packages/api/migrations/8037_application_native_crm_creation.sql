BEGIN;
-- [COMP:api/application-records] Canonical native inserts; no raw RLS grant or actor substitution.
CREATE OR REPLACE FUNCTION application_native_create_allows(type_key text,record_id uuid,owner_id uuid,tier text,teams text[],projects uuid[],fields text[]) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; decision jsonb; command_decision jsonb; command_key text; w uuid;
BEGIN
  context:=application_current_maxima();command_key:=nullif(current_setting('app.application_command_key',true),'');
  IF context IS NULL OR context->>'readOnly'='true' OR type_key NOT IN('company','person','deal','task') OR command_key IS NULL
    OR fields IS NULL OR cardinality(fields)>128 OR array_position(fields,NULL) IS NOT NULL
    OR NOT agent_mutation_scope_allows(teams) THEN RETURN false; END IF;
  w:=(context->>'workspaceId')::uuid;
  decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id::text,owner_id,tier,teams,projects,NULL,'create');
  command_decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id::text,owner_id,tier,teams,projects,NULL,'command:'||command_key);
  RETURN coalesce(decision IS NOT NULL AND command_decision IS NOT NULL
    AND to_jsonb(fields)<@(decision->'write') AND to_jsonb(fields)<@(command_decision->'write'),false);
END;
$$;
REVOKE ALL ON FUNCTION application_native_create_allows(text,uuid,uuid,text,text[],uuid[],text[]) FROM PUBLIC;

CREATE FUNCTION application_create_canonical_crm_entity(params jsonb) RETURNS SETOF public.entities
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;actor uuid;assistant uuid;w uuid;record_id uuid:=gen_random_uuid();
 type_key text;tier text;teams text[];projects uuid[];attributes jsonb;allowed text[];fields text[];entry record;
BEGIN
 context:=public.application_current_maxima();actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 assistant:=nullif(current_setting('app.application_assistant_id',true),'')::uuid;w:=(context->>'workspaceId')::uuid;
 type_key:=params->>'kind';attributes:=coalesce(params->'attributes','{}');tier:=coalesce(params->>'sensitivity','internal');
 allowed:=CASE type_key WHEN 'company' THEN ARRAY['domain','tags'] WHEN 'person' THEN ARRAY['email','phone','tags']
  WHEN 'deal' THEN ARRAY['stage','amount'] ELSE NULL END;
 IF context IS NULL OR actor IS NULL OR allowed IS NULL OR jsonb_typeof(params) IS DISTINCT FROM 'object'
  OR params-ARRAY['kind','displayName','canonicalId','aliases','attributes','sensitivity','workspaceId','userId','assistantId','createdByUserId','createdByAssistantId','source','sourceEpisodeId','sourceSessionId','compartments','projectIds','explicitGeneral']<>'{}'::jsonb
  OR params->>'workspaceId' IS DISTINCT FROM w::text OR params->>'createdByUserId' IS DISTINCT FROM actor::text
  OR params->>'createdByAssistantId' IS NOT NULL AND params->>'createdByAssistantId'<>assistant::text
  OR params->>'userId' IS NOT NULL OR params->>'assistantId' IS NOT NULL OR coalesce(params->>'source','user')<>'user'
  OR params->>'sourceEpisodeId' IS NOT NULL OR params->>'sourceSessionId' IS NOT NULL
  OR jsonb_typeof(params->'displayName') IS DISTINCT FROM 'string' OR length(params->>'displayName') NOT BETWEEN 1 AND 256
  OR jsonb_typeof(attributes) IS DISTINCT FROM 'object' OR attributes-allowed<>'{}'::jsonb
  OR coalesce(attributes->'tags','[]')<>'[]'::jsonb OR coalesce(params->'aliases','[]')<>'[]'::jsonb
  OR params->>'canonicalId' IS DISTINCT FROM (CASE type_key WHEN 'company' THEN coalesce(attributes->>'domain',CASE WHEN params->>'canonicalId'='' THEN '' ELSE NULL END)
    WHEN 'person' THEN coalesce(attributes->>'email',CASE WHEN params->>'canonicalId'='' THEN '' ELSE NULL END) ELSE NULL END) THEN
  RAISE EXCEPTION 'invalid_value: unsupported canonical native creation' USING ERRCODE='22023';
 END IF;
 teams:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'compartments','[]')));
 projects:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'projectIds','[]'))::uuid);
 fields:=ARRAY['name'];
 FOR entry IN SELECT key,value FROM jsonb_each(attributes) WHERE key<>'tags' LOOP fields:=fields||entry.key;END LOOP;
 IF NOT public.application_native_create_allows(type_key,record_id,actor,tier,teams,projects,fields) THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY INSERT INTO public.entities(id,workspace_id,kind,display_name,canonical_id,aliases,attributes,sensitivity,compartments,project_ids,
  user_id,assistant_id,created_by_user_id,created_by_assistant_id,source)
 VALUES(record_id,w,type_key,params->>'displayName',params->>'canonicalId','{}',attributes,tier,teams,projects,NULL,NULL,actor,assistant,'user') RETURNING *;
END $$;
REVOKE ALL ON FUNCTION application_create_canonical_crm_entity(jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_create_canonical_company(params jsonb) RETURNS SETOF public.entities
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF params->>'kind' IS DISTINCT FROM 'company' THEN RAISE EXCEPTION 'invalid_value: unsupported canonical creation' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT * FROM public.application_create_canonical_crm_entity(params);
END $$;
REVOKE ALL ON FUNCTION application_create_canonical_company(jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_native_creation_ref(type_key text,record_id uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; w uuid; scope jsonb; version text;
BEGIN
  context:=application_current_maxima();w:=(context->>'workspaceId')::uuid;
  IF context IS NULL OR type_key NOT IN('company','person','deal','task') THEN RETURN NULL; END IF;
  scope:=application_reference_scope(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id);
  IF scope IS NULL OR NOT application_native_create_allows(type_key,record_id,(scope->>'ownerId')::uuid,scope->>'sensitivity',
    ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid),fields) THEN RETURN NULL; END IF;
  IF type_key IN('company','person','deal') THEN SELECT e.scope_version::text INTO version FROM entities e WHERE e.id=record_id AND e.workspace_id=w;
  ELSE SELECT t.scope_version::text INTO version FROM tasks t WHERE t.id=record_id AND t.workspace_id=w; END IF;
  RETURN jsonb_build_object('workspaceId',w,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey',type_key,'id',record_id,'version',version);
END;
$$;
REVOKE ALL ON FUNCTION application_native_creation_ref(text,uuid,text[]) FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION application_create_canonical_crm_entity(jsonb) TO app_user;
 END IF;
END $$;
COMMIT;
