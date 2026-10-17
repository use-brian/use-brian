BEGIN;

-- Application creation uses the same canonical tables, constraints and version
-- triggers. These fixed helpers admit actual application actors without adding
-- a membership, borrowing an owner identity or releasing existing payloads.
CREATE FUNCTION application_native_create_allows(type_key text,record_id uuid,owner_id uuid,tier text,teams text[],projects uuid[],fields text[]) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; decision jsonb; command_decision jsonb; command_key text; w uuid;
BEGIN
  context:=application_current_maxima();command_key:=nullif(current_setting('app.application_command_key',true),'');
  IF context IS NULL OR context->>'readOnly'='true' OR type_key NOT IN('company','task') OR command_key IS NULL
    OR NOT agent_mutation_scope_allows(teams) THEN RETURN false; END IF;
  w:=(context->>'workspaceId')::uuid;
  decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id::text,owner_id,tier,teams,projects,NULL,'create');
  command_decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id::text,owner_id,tier,teams,projects,NULL,'command:'||command_key);
  RETURN coalesce(decision IS NOT NULL AND command_decision IS NOT NULL
    AND to_jsonb(fields)<@(decision->'write') AND to_jsonb(fields)<@(command_decision->'write'),false);
END;
$$;
REVOKE ALL ON FUNCTION application_native_create_allows(text,uuid,uuid,text,text[],uuid[],text[]) FROM PUBLIC;

CREATE FUNCTION application_native_creation_admitted(type_key text,tier text,teams text[],projects uuid[],fields text[]) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT application_native_create_allows(type_key,gen_random_uuid(),nullif(current_setting('app.current_user_id',true),'')::uuid,tier,teams,projects,fields)
$$;
REVOKE ALL ON FUNCTION application_native_creation_admitted(text,text,text[],uuid[],text[]) FROM PUBLIC;

CREATE FUNCTION application_create_canonical_company(params jsonb) RETURNS SETOF entities
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; actor uuid; assistant uuid; w uuid; record_id uuid:=gen_random_uuid(); tier text; teams text[]; projects uuid[]; fields text[]:=ARRAY['name']; attributes jsonb;
BEGIN
  context:=application_current_maxima();actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  assistant:=nullif(current_setting('app.application_assistant_id',true),'')::uuid;w:=(context->>'workspaceId')::uuid;
  attributes:=coalesce(params->'attributes','{}');tier:=coalesce(params->>'sensitivity','internal');
  IF context IS NULL OR jsonb_typeof(params) IS DISTINCT FROM 'object'
    OR params-ARRAY['kind','displayName','canonicalId','aliases','attributes','sensitivity','workspaceId','userId','assistantId','createdByUserId','createdByAssistantId','source','sourceEpisodeId','sourceSessionId','compartments','projectIds','explicitGeneral']<>'{}'::jsonb
    OR params->>'kind' IS DISTINCT FROM 'company' OR params->>'workspaceId' IS DISTINCT FROM w::text OR params->>'createdByUserId' IS DISTINCT FROM actor::text
    OR params->>'createdByAssistantId' IS NOT NULL AND params->>'createdByAssistantId'<>assistant::text
    OR params->>'userId' IS NOT NULL OR params->>'assistantId' IS NOT NULL OR coalesce(params->>'source','user')<>'user'
    OR params->>'sourceEpisodeId' IS NOT NULL OR params->>'sourceSessionId' IS NOT NULL
    OR jsonb_typeof(params->'displayName') IS DISTINCT FROM 'string' OR length(params->>'displayName') NOT BETWEEN 1 AND 256
    OR jsonb_typeof(attributes) IS DISTINCT FROM 'object' OR attributes-ARRAY['domain','tags']<>'{}'::jsonb
    OR coalesce(attributes->'tags','[]')<>'[]'::jsonb OR coalesce(params->'aliases','[]')<>'[]'::jsonb
    OR attributes ? 'domain' AND (jsonb_typeof(attributes->'domain')<>'string' OR length(attributes->>'domain')>256)
    OR params->>'canonicalId' IS DISTINCT FROM coalesce(attributes->>'domain',CASE WHEN params->>'canonicalId'='' THEN '' ELSE NULL END) THEN
    RAISE EXCEPTION 'invalid_value: unsupported canonical creation' USING ERRCODE='22023';
  END IF;
  teams:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'compartments','[]')));
  projects:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'projectIds','[]'))::uuid);
  IF attributes ? 'domain' THEN fields:=fields||'domain'::text; END IF;
  IF NOT application_native_create_allows('company',record_id,actor,tier,teams,projects,fields) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,aliases,attributes,sensitivity,compartments,project_ids,
    user_id,assistant_id,created_by_user_id,created_by_assistant_id,source)
    VALUES(record_id,w,'company',params->>'displayName',params->>'canonicalId','{}',attributes,tier,teams,projects,NULL,NULL,actor,assistant,'user') RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION application_create_canonical_company(jsonb) FROM PUBLIC;

CREATE FUNCTION application_create_canonical_task(params jsonb) RETURNS SETOF tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; actor uuid; assistant uuid; w uuid; record_id uuid:=gen_random_uuid(); tier text; teams text[]; projects uuid[]; fields text[]:=ARRAY['title'];
BEGIN
  context:=application_current_maxima();actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  assistant:=nullif(current_setting('app.application_assistant_id',true),'')::uuid;w:=(context->>'workspaceId')::uuid;
  IF context IS NULL OR jsonb_typeof(params) IS DISTINCT FROM 'object'
    OR params-ARRAY['workspaceId','title','status','sensitivity','compartments','projectIds','createdByAssistantId']<>'{}'::jsonb
    OR params->>'workspaceId' IS DISTINCT FROM w::text OR jsonb_typeof(params->'title') IS DISTINCT FROM 'string' OR length(params->>'title') NOT BETWEEN 1 AND 1024
    OR params->>'createdByAssistantId' IS NOT NULL AND params->>'createdByAssistantId'<>assistant::text THEN
    RAISE EXCEPTION 'invalid_value: unsupported canonical creation' USING ERRCODE='22023';
  END IF;
  tier:=coalesce(params->>'sensitivity','internal');teams:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'compartments','[]')));
  projects:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'projectIds','[]'))::uuid);
  IF params ? 'status' THEN fields:=fields||'status'::text; END IF;
  IF cardinality(projects)>1 OR EXISTS(SELECT 1 FROM unnest(projects) p WHERE NOT EXISTS(SELECT 1 FROM workspace_projects pr WHERE pr.id=p AND pr.workspace_id=w AND pr.status='active')) THEN
    RAISE EXCEPTION 'invalid_value: project unavailable' USING ERRCODE='22023'; END IF;
  IF NOT application_native_create_allows('task',record_id,actor,tier,teams,projects,fields) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY INSERT INTO tasks(id,workspace_id,title,status,created_by_user_id,created_by_assistant_id,sensitivity,compartments,project_ids,source)
    VALUES(record_id,w,params->>'title',coalesce(params->>'status','todo'),actor,assistant,tier,teams,projects,'user') RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION application_create_canonical_task(jsonb) FROM PUBLIC;

CREATE FUNCTION application_native_creation_ref(type_key text,record_id uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; w uuid; scope jsonb; version text;
BEGIN
  context:=application_current_maxima();w:=(context->>'workspaceId')::uuid;
  IF context IS NULL OR type_key NOT IN('company','task') THEN RETURN NULL; END IF;
  scope:=application_reference_scope(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id);
  IF scope IS NULL OR NOT application_native_create_allows(type_key,record_id,(scope->>'ownerId')::uuid,scope->>'sensitivity',
    ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid),fields) THEN RETURN NULL; END IF;
  IF type_key='company' THEN SELECT e.scope_version::text INTO version FROM entities e WHERE e.id=record_id AND e.workspace_id=w;
  ELSE SELECT t.scope_version::text INTO version FROM tasks t WHERE t.id=record_id AND t.workspace_id=w; END IF;
  RETURN jsonb_build_object('workspaceId',w,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey',type_key,'id',record_id,'version',version);
END;
$$;
REVOKE ALL ON FUNCTION application_native_creation_ref(text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_native_review_ids(w uuid,type_key text,selector jsonb,subject uuid) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF selector->>'kind'='ids' THEN RETURN QUERY SELECT jsonb_array_elements_text(selector->'ids')::uuid;RETURN; END IF;
  IF selector->>'kind'<>'self' THEN RETURN; END IF;
  IF type_key IN('company','person','deal') THEN
    RETURN QUERY SELECT e.id FROM entities e WHERE e.workspace_id=w AND e.kind=type_key AND e.created_by_user_id=subject AND e.valid_to IS NULL AND e.retracted_at IS NULL AND NOT e.scope_held;
  ELSIF type_key='task' THEN
    RETURN QUERY SELECT t.id FROM tasks t WHERE t.workspace_id=w AND t.created_by_user_id=subject AND t.valid_to IS NULL AND t.retracted_at IS NULL AND NOT t.scope_held;
  ELSIF type_key='file' THEN
    RETURN QUERY SELECT f.id FROM workspace_files f WHERE f.workspace_id=w AND f.created_by_user_id=subject AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held;
  ELSIF type_key='workspace_member' THEN
    RETURN QUERY SELECT m.user_id FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=subject;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION application_native_review_ids(uuid,text,jsonb,uuid) FROM PUBLIC;

-- Extend the existing native release validator additively. There is still one
-- current policy implementation; the guarded substitutions fail if it drifts.
DO $migration$ DECLARE definition text; original text; replacement text; BEGIN
  SELECT pg_get_functiondef('application_grant_release_snapshot(uuid,jsonb)'::regprocedure) INTO definition;
  original:=$before$AND app.module_key='native' AND proposal->'selector'->>'kind'='ids' THEN$before$;
  replacement:=$after$AND app.module_key='native' AND proposal->'selector'->>'kind' IN('ids','self') THEN$after$;
  IF position(original IN definition)=0 THEN RAISE EXCEPTION 'Native review branch changed'; END IF;
  definition:=replace(definition,original,replacement);
  original:=$before$FOR row_id IN SELECT jsonb_array_elements_text(proposal->'selector'->'ids')::uuid LOOP$before$;
  replacement:=$after$FOR row_id IN SELECT id FROM application_native_review_ids(app.workspace_id,proposal->>'typeKey',proposal->'selector',subject) id ORDER BY id LOOP$after$;
  IF position(original IN definition)=0 THEN RAISE EXCEPTION 'Native review selection changed'; END IF;
  definition:=replace(definition,original,replacement);
  original:=$before$OR scope->>'userId' IS NOT NULL AND scope->>'userId'<>subject::text THEN RETURN NULL; END IF;$before$;
  replacement:=$after$OR scope->>'userId' IS NOT NULL AND scope->>'userId'<>subject::text
        OR sensitivity_rank(scope->>'sensitivity')>sensitivity_rank(proposal->>'clearance')
        OR NOT (scope->'compartments')<@(proposal->'compartments') OR NOT (scope->'projectIds')<@(proposal->'projectIds') THEN
          IF proposal->'selector'->>'kind'='self' THEN CONTINUE; ELSE RETURN NULL; END IF;
        END IF;$after$;
  IF position(original IN definition)=0 THEN RAISE EXCEPTION 'Native review floor changed'; END IF;
  EXECUTE replace(definition,original,replacement);
END $migration$;

ALTER FUNCTION application_native_catalog() RENAME TO application_native_existing_catalog;
REVOKE ALL ON FUNCTION application_native_existing_catalog() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION application_native_existing_catalog() FROM app_user; END IF;
END $$;
CREATE FUNCTION application_native_catalog() RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; candidate record; entry jsonb; entries jsonb:='{}'; decision jsonb; fields text[]; builtins text[]; custom_fields jsonb; type_key text;
BEGIN
  context:=application_current_maxima();
  IF context IS NULL THEN RETURN; END IF;
  FOR entry IN SELECT application_native_existing_catalog() LOOP entries:=entries||jsonb_build_object(entry->>'typeKey',entry); END LOOP;
  IF context->>'readOnly'='false' THEN
    FOR candidate IN SELECT DISTINCT g.resource_type,g.compartments,g.project_ids FROM jsonb_array_elements(context->'layers') layer,
      LATERAL jsonb_array_elements(layer->'maxima') m JOIN application_access_grants g ON g.id=(m->'grants'->0->>'id')::uuid
      WHERE g.app_id=(context->>'appId')::uuid AND g.resource_origin='{"kind":"native","moduleKey":"native"}'::jsonb
        AND g.resource_type IN('company','task') AND g.selector->>'kind'='self' AND 'create'=ANY(g.actions) LOOP
      type_key:=candidate.resource_type;
      decision:=application_resource_fields((context->>'workspaceId')::uuid,'{"kind":"native","moduleKey":"native"}',type_key,
        '00000000-0000-4000-8000-000000000000',nullif(current_setting('app.current_user_id',true),'')::uuid,'public',candidate.compartments,candidate.project_ids,NULL,'create');
      IF decision IS NULL THEN CONTINUE; END IF;
      builtins:=CASE type_key WHEN 'company' THEN ARRAY['name','domain'] ELSE ARRAY['title','status'] END;
      fields:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((decision->'read')||(decision->'write')) value
        WHERE value=ANY(builtins) OR EXISTS(SELECT 1 FROM crm_field_definitions f WHERE f.workspace_id=(context->>'workspaceId')::uuid
          AND f.entity_kind=type_key AND f.archived_at IS NULL AND 'custom.'||f.field_key=value));
      fields:=fields||ARRAY(SELECT jsonb_array_elements_text(coalesce(entries->type_key->'fields','[]')));
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'entityKind',f.entity_kind,'fieldKey',f.field_key,'label',f.label,
        'fieldType',f.field_type,'options',f.options,'isRequired',f.is_required,'position',f.position) ORDER BY f.position,f.id),'[]') INTO custom_fields
        FROM crm_field_definitions f WHERE f.workspace_id=(context->>'workspaceId')::uuid AND f.entity_kind=type_key
          AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(fields);
      entries:=entries||jsonb_build_object(type_key,jsonb_build_object('typeKey',type_key,'fields',ARRAY(SELECT DISTINCT unnest(fields) ORDER BY 1),'customFields',custom_fields));
    END LOOP;
  END IF;
  RETURN QUERY SELECT value FROM jsonb_each(entries) ORDER BY key;
END;
$$;
REVOKE ALL ON FUNCTION application_native_catalog() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    GRANT EXECUTE ON FUNCTION application_native_catalog(),application_native_creation_admitted(text,text,text[],uuid[],text[]),application_create_canonical_company(jsonb),application_create_canonical_task(jsonb),application_native_creation_ref(text,uuid,text[]) TO app_user;
  END IF;
END $$;
COMMIT;
