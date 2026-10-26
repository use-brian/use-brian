BEGIN;
-- [COMP:api/application-records] R2 canonical native operations share one store.
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.application_company_patch_state(uuid,text[])'::regprocedure) INTO definition;
 before:='application_company_patch_state(record_id uuid, fields text[])';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical patch metadata signature changed';END IF;
 definition:=replace(definition,before,'application_crm_patch_state(p_type text, record_id uuid, fields text[])');
 definition:=replace(definition,$source$e.kind='company'$source$,'e.kind=p_type');
 definition:=replace(definition,'''company'',r.id','p_type,r.id');
 definition:=replace(definition,'IF actor IS NULL OR fields IS NULL','IF p_type NOT IN(''company'',''person'',''deal'') OR actor IS NULL OR fields IS NULL');
 EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION application_crm_patch_state(text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_patch_canonical_crm(p_type text,record_id uuid,patch jsonb,expected_version text DEFAULT NULL,inherited jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fields text[];state jsonb;original public.entities;attributes_patch jsonb:='{}';previous_intent text;updated_version text;
 teams text[];projects uuid[];tier text;reference jsonb;target_scope jsonb;sets text;entry record;attribute_key text;aliases_value text[];
 stage public.crm_pipeline_stages;merged jsonb;allowed text[];
BEGIN
 allowed:=ARRAY['name','aliases','tags','externalRef','ownerId','archivedAt','customFields']||CASE p_type
  WHEN 'company' THEN ARRAY['domain'] WHEN 'person' THEN ARRAY['email','phone','companyId']
  WHEN 'deal' THEN ARRAY['stage','amount','companyId','contactId','closeDate','pipelineId','pipelineStageId','currencyCode','source','winLossReason','probability'] ELSE NULL END;
 IF allowed IS NULL OR jsonb_typeof(patch) IS DISTINCT FROM 'object' OR patch-allowed<>'{}'
  OR patch ? 'name' AND (jsonb_typeof(patch->'name') IS DISTINCT FROM 'string' OR length(btrim(patch->>'name'))=0 OR length(patch->>'name')>256)
  OR patch ? 'customFields' AND jsonb_typeof(patch->'customFields') IS DISTINCT FROM 'object'
  OR inherited IS NOT NULL AND (jsonb_typeof(inherited) IS DISTINCT FROM 'object' OR inherited-ARRAY['compartments','projectIds','sensitivity']<>'{}') THEN
  RAISE EXCEPTION 'invalid_value: invalid canonical CRM patch' USING ERRCODE='22023';END IF;
 fields:=ARRAY(SELECT key FROM jsonb_object_keys(patch) key WHERE key<>'customFields' UNION SELECT 'custom.'||key FROM jsonb_object_keys(coalesce(patch->'customFields','{}')) key ORDER BY 1);
 -- A stage selector writes its canonical pipeline and legacy stage together.
 IF patch ? 'pipelineStageId' AND patch->'pipelineStageId'<>'null' THEN fields:=ARRAY(SELECT DISTINCT unnest(fields||ARRAY['pipelineId','stage']) ORDER BY 1);END IF;
 state:=application_crm_patch_state(p_type,record_id,fields);
 IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF expected_version IS NOT NULL AND (expected_version !~ '^[1-9]\d*$' OR state->>'version'<>expected_version) THEN
  RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';END IF;
 IF patch='{}' AND inherited IS NULL THEN RETURN jsonb_build_object('workspaceId',state->'workspaceId','origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey',p_type,'id',record_id,'version',state->'version');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(patch->'customFields','{}')) provided WHERE NOT EXISTS(
  SELECT 1 FROM crm_field_definitions f WHERE f.workspace_id=(state->>'workspaceId')::uuid AND f.entity_kind=p_type AND f.field_key=provided AND f.archived_at IS NULL)
  AND NOT(p_type='person' AND provided IN('organisation_name','position','mailing_address'))) THEN
  RAISE EXCEPTION 'invalid_value: undeclared canonical custom field' USING ERRCODE='22023';END IF;
 SELECT * INTO original FROM public.entities WHERE id=record_id;
 teams:=original.compartments;projects:=original.project_ids;tier:=original.sensitivity;
 IF inherited IS NOT NULL THEN
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(coalesce(inherited->'compartments','[]')))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(coalesce(inherited->'projectIds','[]'))::uuid)) value ORDER BY value);
  IF inherited->>'sensitivity' IS NOT NULL THEN
   IF sensitivity_rank(inherited->>'sensitivity') IS NULL THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
   IF sensitivity_rank(inherited->>'sensitivity')>sensitivity_rank(tier) THEN tier:=inherited->>'sensitivity';END IF;
  END IF;
 END IF;
 FOR entry IN SELECT * FROM jsonb_each(patch) WHERE key NOT IN('name','aliases','customFields') LOOP
  attribute_key:=CASE entry.key WHEN 'externalRef' THEN 'external_ref' WHEN 'ownerId' THEN 'owner_id' WHEN 'archivedAt' THEN 'crm_archived_at'
   WHEN 'companyId' THEN 'company_id' WHEN 'contactId' THEN 'contact_id' WHEN 'closeDate' THEN 'close_date' WHEN 'pipelineId' THEN 'pipeline_id'
   WHEN 'pipelineStageId' THEN 'pipeline_stage_id' WHEN 'currencyCode' THEN 'currency_code' WHEN 'winLossReason' THEN 'win_loss_reason' ELSE entry.key END;
  IF entry.value<>'null'::jsonb AND NOT(entry.key IN('domain','email','phone') AND entry.value='""'::jsonb) THEN
   attributes_patch:=attributes_patch||jsonb_build_object(attribute_key,entry.value);END IF;
 END LOOP;
 IF patch ? 'customFields' THEN attributes_patch:=attributes_patch||jsonb_build_object('custom_fields',(SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(patch->'customFields') WHERE value<>'null'::jsonb AND value<>'""'::jsonb));END IF;
 IF patch ? 'pipelineStageId' AND patch->'pipelineStageId'<>'null' THEN
  SELECT s.* INTO stage FROM crm_pipeline_stages s JOIN crm_pipelines p ON p.id=s.pipeline_id AND p.workspace_id=s.workspace_id
   WHERE s.id=(patch->>'pipelineStageId')::uuid AND s.workspace_id=original.workspace_id AND s.archived_at IS NULL AND p.archived_at IS NULL FOR SHARE OF s,p;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  IF patch ? 'pipelineId' AND patch->>'pipelineId' IS DISTINCT FROM stage.pipeline_id::text THEN RAISE EXCEPTION 'invalid_value: stage pipeline mismatch' USING ERRCODE='22023';END IF;
  attributes_patch:=attributes_patch||jsonb_build_object('pipeline_id',stage.pipeline_id,'stage',coalesce(stage.legacy_key,CASE stage.category WHEN 'won' THEN 'won' WHEN 'lost' THEN 'lost' ELSE 'lead' END));
  merged:=application_merge_native_entity_attributes(original.attributes,attributes_patch,fields);
  IF EXISTS(SELECT 1 FROM unnest(stage.required_fields) key WHERE coalesce(merged->key,merged->'custom_fields'->key,'null') IN('null'::jsonb,'""'::jsonb)) THEN
   RAISE EXCEPTION 'invalid_value: required stage fields are missing' USING ERRCODE='22023';END IF;
 END IF;
 FOR reference IN SELECT value FROM jsonb_array_elements(application_field_references(original.workspace_id,'{"kind":"native","moduleKey":"native"}',p_type,application_native_entity_attribute_values(attributes_patch))) LOOP
  -- Catalog IDs are validated by the locked canonical relationship trigger.
  IF reference->>'typeKey' IN('crm_pipeline','crm_pipeline_stage') THEN CONTINUE;END IF;
  IF application_field_reference_admitted(original.workspace_id,reference) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  target_scope:=read_scope_source(original.workspace_id,CASE WHEN reference->>'typeKey'='workspace_member' THEN 'workspace_member' ELSE 'entity' END,(reference->>'id')::uuid);
  IF target_scope IS NULL OR target_scope->>'held' IS DISTINCT FROM 'false' OR target_scope->>'userId' IS NOT NULL AND target_scope->>'userId' IS DISTINCT FROM original.user_id::text
   OR target_scope->>'assistantId' IS NOT NULL AND target_scope->>'assistantId' IS DISTINCT FROM original.assistant_id::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(target_scope->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(target_scope->'projectIds')::uuid)) value ORDER BY value);
  IF sensitivity_rank(target_scope->>'sensitivity')>sensitivity_rank(tier) THEN tier:=target_scope->>'sensitivity';END IF;
 END LOOP;
 IF agent_mutation_scope_allows(teams) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF cardinality(fields)=0 AND tier=original.sensitivity AND teams=original.compartments AND projects=original.project_ids THEN
  RETURN jsonb_build_object('workspaceId',original.workspace_id,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey',p_type,'id',record_id,'version',original.scope_version::text);END IF;
 previous_intent:=coalesce(current_setting('app.native_entity_write_intent',true),'');
 PERFORM set_config('app.native_entity_write_intent',jsonb_build_object('workspaceId',original.workspace_id,'typeKey',p_type,'id',record_id,'fields',fields)::text,true);
 aliases_value:=original.aliases;
 IF patch ? 'aliases' THEN aliases_value:=ARRAY(SELECT DISTINCT lower(btrim(value)) FROM jsonb_array_elements_text(patch->'aliases') value ORDER BY 1);END IF;
 sets:='attributes=public.application_merge_native_entity_attributes(attributes,$1,$2),sensitivity=$3,compartments=$4,project_ids=$5,updated_at=clock_timestamp()';
 IF patch ? 'aliases' THEN sets:=sets||',aliases=$9';END IF;
 IF patch ? 'name' THEN sets:=sets||',display_name=$6';END IF;
 IF p_type='company' AND patch ? 'domain' OR p_type='person' AND patch ? 'email' THEN sets:=sets||',canonical_id=$7';END IF;
 EXECUTE 'UPDATE public.entities SET '||sets||' WHERE id=$8 RETURNING scope_version::text'
  INTO updated_version USING attributes_patch,fields,tier,teams,projects,patch->>'name',CASE p_type WHEN 'company' THEN patch->>'domain' WHEN 'person' THEN patch->>'email' END,record_id,aliases_value;
 PERFORM set_config('app.native_entity_write_intent',previous_intent,true);
 state:=application_crm_patch_state(p_type,record_id,fields);
 IF state IS NULL OR state->>'version' IS DISTINCT FROM updated_version THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('workspaceId',original.workspace_id,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey',p_type,'id',record_id,'version',updated_version);
END $$;
REVOKE ALL ON FUNCTION application_patch_canonical_crm(text,uuid,jsonb,text,jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_patch_canonical_company(record_id uuid,patch jsonb,expected_version text DEFAULT NULL,inherited jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT application_patch_canonical_crm('company',record_id,patch,expected_version,inherited) $$;
REVOKE ALL ON FUNCTION application_patch_canonical_company(uuid,jsonb,text,jsonb) FROM PUBLIC;

-- Shared sidecar history captures semantic native changes from every entry point.
CREATE FUNCTION application_capture_native_crm_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.kind IN('company','person','deal') AND NEW.scope_version IS DISTINCT FROM OLD.scope_version
  AND (NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.canonical_id IS DISTINCT FROM OLD.canonical_id
   OR NEW.aliases IS DISTINCT FROM OLD.aliases OR NEW.attributes IS DISTINCT FROM OLD.attributes
   OR NEW.updated_at IS DISTINCT FROM OLD.updated_at)
  AND NEW.retracted_at IS NOT DISTINCT FROM OLD.retracted_at THEN
  INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor,mutation_reason,sensitivity,workspace_id)
   SELECT 'entity',OLD.id,coalesce(max(v.version_no),0)+1,(to_jsonb(OLD)-'embedding')||CASE WHEN OLD.kind='deal' THEN jsonb_build_object('native_participants',coalesce((SELECT jsonb_agg(jsonb_build_object('contactId',p.contact_id,'role',p.role,'isPrimary',p.is_primary) ORDER BY p.contact_id) FROM crm_deal_contacts p WHERE p.workspace_id=OLD.workspace_id AND p.deal_id=OLD.id),'[]')) ELSE '{}'::jsonb END,coalesce(max(v.valid_to),OLD.created_at),clock_timestamp(),
    CASE WHEN nullif(current_setting('app.application_id',true),'') IS NULL THEN 'human_edit' ELSE 'assistant_turn' END,
    'native.'||OLD.kind||'.patch',OLD.sensitivity,OLD.workspace_id FROM brain_row_versions v WHERE v.primitive='entity' AND v.row_id=OLD.id;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_capture_native_crm_revision() FROM PUBLIC;
CREATE TRIGGER application_native_crm_revision AFTER UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION application_capture_native_crm_revision();
CREATE OR REPLACE FUNCTION application_version_typed_company_patch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent jsonb:=nullif(current_setting('app.native_entity_write_intent',true),'')::jsonb;
BEGIN
 IF NEW.kind IN('company','person','deal') AND intent->>'workspaceId'=OLD.workspace_id::text AND intent->>'typeKey'=OLD.kind AND intent->>'id'=OLD.id::text
  AND jsonb_typeof(intent->'fields')='array' AND jsonb_array_length(intent->'fields') BETWEEN 1 AND 128 AND NEW.scope_version=OLD.scope_version THEN NEW.scope_version:=OLD.scope_version+1;END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_version_typed_company_patch() FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_hold_company_patch_descendants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.kind IN('company','person','deal') AND NEW.scope_version<>OLD.scope_version AND entity_scope_semantic_row(to_jsonb(NEW))=entity_scope_semantic_row(to_jsonb(OLD)) THEN
  PERFORM hold_scope_descendants(NEW.workspace_id,'entity',NEW.id);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_hold_company_patch_descendants() FROM PUBLIC;

ALTER FUNCTION application_native_field_keys(text) RENAME TO application_native_field_keys_before_completion;
REVOKE ALL ON FUNCTION application_native_field_keys_before_completion(text) FROM PUBLIC;
CREATE FUNCTION application_native_field_keys(p_type text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_native_field_keys_before_completion(p_type)||CASE p_type WHEN 'person' THEN ARRAY['self']
 WHEN 'task' THEN ARRAY['assigneeId','executorAssistantId','followUpMemberId','home','due','tags','parentId','externalRef','attributes','createdAt','updatedAt','sourceEpisodeId','sourceStartMs','verified','createdByUserId','createdByAssistantId','source','sourceSessionId'] ELSE '{}'::text[] END
$$;
REVOKE ALL ON FUNCTION application_native_field_keys(text) FROM PUBLIC;
ALTER FUNCTION application_native_entity_values(text,jsonb) RENAME TO application_native_entity_values_before_completion;
REVOKE ALL ON FUNCTION application_native_entity_values_before_completion(text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_entity_values(p_type text,payload jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_native_entity_values_before_completion(p_type,payload)||CASE p_type WHEN 'person' THEN jsonb_build_object('self',coalesce(payload#>'{attributes,self}','false')) ELSE '{}'::jsonb END
$$;
REVOKE ALL ON FUNCTION application_native_entity_values(text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_task_values(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN jsonb_build_object('title',payload->'title','status',payload->'status','assigneeId',payload->'assignee_id','executorAssistantId',payload->'executor_assistant_id',
 'followUpMemberId',payload->'follow_up_member_id','home',CASE WHEN payload->>'home_kind' IS NOT NULL THEN jsonb_build_object('kind',payload->'home_kind','id',payload->'home_id') ELSE 'null'::jsonb END,
 'due',CASE WHEN payload->>'due' IS NOT NULL THEN to_char((payload->>'due')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
 'createdByUserId',payload->'created_by_user_id','createdByAssistantId',payload->'created_by_assistant_id','source',payload->'source','sourceSessionId',payload->'source_session_id',
 'sourceEpisodeId',payload->'source_episode_id','sourceStartMs',payload->'source_start_ms','verified',(payload->>'verified_by_user_id') IS NOT NULL,
 'tags',payload->'tags','parentId',coalesce((SELECT to_jsonb(parent.logical_id) FROM tasks parent
  WHERE parent.workspace_id=(payload->>'workspace_id')::uuid AND parent.id=(payload->>'parent_id')::uuid),payload->'parent_id'),
 'externalRef',payload->'external_ref','attributes',payload->'attributes',
 'createdAt',to_char((payload->>'created_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char((payload->>'updated_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;
REVOKE ALL ON FUNCTION application_native_task_values(jsonb) FROM PUBLIC;

-- Pure task value constraints are shared by canonical SQL ports and raw rows.
CREATE FUNCTION application_native_task_patch_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text;item jsonb;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF value ? 'title' AND (jsonb_typeof(value->'title') IS DISTINCT FROM 'string' OR length(btrim(value->>'title')) NOT BETWEEN 1 AND 512)
  OR value ? 'status' AND (jsonb_typeof(value->'status') IS DISTINCT FROM 'string' OR value->>'status' NOT IN('todo','in_progress','in_review','blocked','done','archived')) THEN RETURN false;END IF;
 FOREACH key IN ARRAY ARRAY['assigneeId','executorAssistantId','followUpMemberId','parentId'] LOOP
  IF value ? key AND value->key<>'null'::jsonb AND (jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR value->>key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN false;END IF;
 END LOOP;
 IF value ? 'home' AND value->'home'<>'null'::jsonb THEN
  item:=value->'home';
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['kind','id']<>'{}'::jsonb OR NOT item ?& ARRAY['kind','id']
   OR jsonb_typeof(item->'kind') IS DISTINCT FROM 'string' OR item->>'kind' NOT IN('department','project')
   OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR item->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;
 END IF;
 IF value ? 'due' AND value->'due'<>'null'::jsonb AND jsonb_typeof(value->'due') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 IF value ? 'tags' THEN
  IF jsonb_typeof(value->'tags') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(value->'tags') tag WHERE jsonb_typeof(tag) IS DISTINCT FROM 'string') THEN RETURN false;END IF;
 END IF;
 FOREACH key IN ARRAY ARRAY['externalRef','attributes'] LOOP
  IF value ? key AND jsonb_typeof(value->key) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION application_native_task_patch_valid(jsonb) FROM PUBLIC;
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('application_native_projection(text,uuid,text,text[])'::regprocedure) INTO definition;
 before:=$source$jsonb_build_object('title',payload->'title','status',payload->'status')$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native task projection changed';END IF;
 EXECUTE replace(definition,before,'application_native_task_values(payload)');
 SELECT pg_get_functiondef('application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure) INTO definition;
 before:=$source$jsonb_build_object('title',native_row->'title','status',native_row->'status')$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native task field projection changed';END IF;
 EXECUTE replace(definition,before,'application_native_task_values(native_row)');
END $migration$;

-- Structural configuration references expose no business payload and never seed.
CREATE FUNCTION application_crm_configuration_reference_admitted(w uuid,reference jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;context jsonb;target uuid;
BEGIN
 IF actor IS NULL OR reference->'origin'<>'{"kind":"native","moduleKey":"native"}'::jsonb
  OR reference->>'typeKey' NOT IN('crm_pipeline','crm_pipeline_stage') OR reference->'fields'<>'[]'::jsonb
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) THEN RETURN false;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  context:=application_current_maxima();IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN false;END IF;
 ELSE IF application_native_query_bounds(w) IS NULL THEN RETURN false;END IF;END IF;
 target:=(reference->>'id')::uuid;
 IF reference->>'typeKey'='crm_pipeline' THEN
  RETURN EXISTS(SELECT 1 FROM crm_pipelines p WHERE p.workspace_id=w AND p.id=target AND p.archived_at IS NULL);
 END IF;
 RETURN EXISTS(SELECT 1 FROM crm_pipeline_stages s JOIN crm_pipelines p ON p.id=s.pipeline_id AND p.workspace_id=s.workspace_id
  WHERE s.workspace_id=w AND s.id=target AND s.archived_at IS NULL AND p.archived_at IS NULL);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_crm_configuration_reference_admitted(uuid,jsonb) FROM PUBLIC;
ALTER FUNCTION application_field_reference_admitted(uuid,jsonb) RENAME TO application_field_reference_admitted_before_native_commands;
REVOKE ALL ON FUNCTION application_field_reference_admitted_before_native_commands(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_field_reference_admitted(w uuid,reference jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF reference->>'typeKey' IN('crm_pipeline','crm_pipeline_stage') THEN RETURN application_crm_configuration_reference_admitted(w,reference);END IF;
 RETURN application_field_reference_admitted_before_native_commands(w,reference);
END $$;
REVOKE ALL ON FUNCTION application_field_reference_admitted(uuid,jsonb) FROM PUBLIC;
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('application_guard_native_reference_invariants()'::regprocedure) INTO definition;
 before:='IF actor IS NOT NULL AND (app_context IS NOT NULL OR application_native_query_bounds(NEW.workspace_id) IS NULL) THEN';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical configuration reference admission changed';END IF;
 EXECUTE replace(definition,before,$source$IF actor IS NOT NULL AND application_crm_configuration_reference_admitted(NEW.workspace_id,
  jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey',target_kind,'id',target_id,'fields','[]'::jsonb)) IS NOT TRUE THEN$source$);
END $migration$;

CREATE OR REPLACE FUNCTION application_create_canonical_crm_entity(params jsonb) RETURNS SETOF public.entities
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;assistant uuid;
 w uuid;record_id uuid:=gen_random_uuid();type_key text:=params->>'kind';tier text;teams text[];projects uuid[];attributes jsonb:=coalesce(params->'attributes','{}');
 fields text[];aliases_value text[];private_user uuid;private_assistant uuid;ref jsonb;scope jsonb;target public.entities;
BEGIN
 context:=application_current_maxima();w:=(params->>'workspaceId')::uuid;tier:=coalesce(params->>'sensitivity','internal');
 assistant:=(params->>'createdByAssistantId')::uuid;private_user:=(params->>'userId')::uuid;private_assistant:=(params->>'assistantId')::uuid;
 IF type_key NOT IN('company','person','deal') OR actor IS NULL OR jsonb_typeof(params) IS DISTINCT FROM 'object'
  OR params-ARRAY['kind','displayName','canonicalId','aliases','attributes','sensitivity','workspaceId','userId','assistantId','createdByUserId','createdByAssistantId','source','sourceEpisodeId','sourceSessionId','compartments','projectIds','explicitGeneral']<>'{}'::jsonb
  OR params->>'createdByUserId' IS DISTINCT FROM actor::text OR coalesce(params->>'source','user')<>'user'
  OR params->>'sourceEpisodeId' IS NOT NULL OR params->>'sourceSessionId' IS NOT NULL
  OR jsonb_typeof(params->'displayName') IS DISTINCT FROM 'string' OR length(btrim(params->>'displayName')) NOT BETWEEN 1 AND 256
  OR jsonb_typeof(attributes) IS DISTINCT FROM 'object'
  OR params->>'canonicalId' IS DISTINCT FROM (CASE type_key WHEN 'company' THEN attributes->>'domain' WHEN 'person' THEN attributes->>'email' ELSE NULL END) THEN
  RAISE EXCEPTION 'invalid_value: unsupported canonical native creation' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(application_native_entity_attribute_values(attributes)) field
  WHERE NOT field=ANY(application_native_field_keys(type_key)) AND NOT starts_with(field,'custom.')) THEN
  RAISE EXCEPTION 'invalid_value: unsupported canonical creation field' USING ERRCODE='22023';END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text OR assistant::text IS DISTINCT FROM nullif(current_setting('app.application_assistant_id',true),'') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 teams:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'compartments','[]')));
 projects:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'projectIds','[]'))::uuid);
 aliases_value:=ARRAY(SELECT DISTINCT lower(btrim(value)) FROM jsonb_array_elements_text(coalesce(params->'aliases','[]')) value ORDER BY 1);
 fields:=ARRAY['name']||ARRAY(SELECT jsonb_object_keys(application_native_entity_attribute_values(attributes)));
 IF cardinality(aliases_value)>0 THEN fields:=fields||'aliases'::text;END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(application_field_references(w,'{"kind":"native","moduleKey":"native"}',type_key,application_native_entity_attribute_values(attributes))) LOOP
  IF application_field_reference_admitted(w,ref) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  IF ref->>'typeKey' IN('crm_pipeline','crm_pipeline_stage') THEN CONTINUE;END IF;
  scope:=read_scope_source(w,CASE WHEN ref->>'typeKey'='workspace_member' THEN 'workspace_member' ELSE 'entity' END,(ref->>'id')::uuid);
  IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  IF scope->>'userId' IS NOT NULL THEN IF private_user IS NOT NULL AND private_user::text<>scope->>'userId' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;private_user:=(scope->>'userId')::uuid;END IF;
  IF scope->>'assistantId' IS NOT NULL THEN IF private_assistant IS NOT NULL AND private_assistant::text<>scope->>'assistantId' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;private_assistant:=(scope->>'assistantId')::uuid;END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(scope->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid)) value ORDER BY value);
  IF sensitivity_rank(scope->>'sensitivity')>sensitivity_rank(tier) THEN tier:=scope->>'sensitivity';END IF;
 END LOOP;
 IF agent_mutation_scope_allows(teams) IS NOT TRUE OR agent_visibility_allows(w,private_user,private_assistant) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF context IS NOT NULL THEN
  IF application_native_create_allows(type_key,record_id,actor,tier,teams,projects,fields,'{}') IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 ELSE
  IF member_operation_scope_allows(w,tier,teams,true) IS NOT TRUE OR agent_read_scope_allows(tier,teams,projects) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN QUERY INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,aliases,attributes,sensitivity,compartments,project_ids,user_id,assistant_id,
  created_by_user_id,created_by_assistant_id,source)
 VALUES(record_id,w,type_key,params->>'displayName',params->>'canonicalId',aliases_value,attributes,tier,teams,projects,private_user,private_assistant,actor,assistant,'user') RETURNING *;
END $$;
REVOKE ALL ON FUNCTION application_create_canonical_crm_entity(jsonb) FROM PUBLIC;
CREATE FUNCTION application_create_canonical_crm_ref(p_type text,input jsonb,scope jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE attrs jsonb:='{}';entry record;attribute_key text;record_value public.entities;params jsonb;allowed text[];stage public.crm_pipeline_stages;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entities'::regclass WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 allowed:=ARRAY(SELECT field FROM unnest(application_native_field_keys(p_type)) field WHERE field NOT IN('createdAt','updatedAt','archivedAt','self'));
 IF p_type NOT IN('company','person','deal') OR jsonb_typeof(input) IS DISTINCT FROM 'object' OR input-(allowed||ARRAY['customFields'])<>'{}' THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
 FOR entry IN SELECT * FROM jsonb_each(input) WHERE key NOT IN('name','aliases','customFields') LOOP
  attribute_key:=CASE entry.key WHEN 'externalRef' THEN 'external_ref' WHEN 'ownerId' THEN 'owner_id' WHEN 'companyId' THEN 'company_id' WHEN 'contactId' THEN 'contact_id'
   WHEN 'closeDate' THEN 'close_date' WHEN 'pipelineId' THEN 'pipeline_id' WHEN 'pipelineStageId' THEN 'pipeline_stage_id' WHEN 'currencyCode' THEN 'currency_code' WHEN 'winLossReason' THEN 'win_loss_reason' ELSE entry.key END;
  IF entry.value<>'null'::jsonb THEN attrs:=attrs||jsonb_build_object(attribute_key,entry.value);END IF;
 END LOOP;
 IF input ? 'customFields' THEN attrs:=attrs||jsonb_build_object('custom_fields',input->'customFields');END IF;
 IF p_type='deal' THEN attrs:=jsonb_build_object('stage','lead')||attrs;END IF;
 IF attrs ? 'pipeline_stage_id' THEN
  SELECT s.* INTO stage FROM crm_pipeline_stages s JOIN crm_pipelines p ON p.id=s.pipeline_id AND p.workspace_id=s.workspace_id
   WHERE s.workspace_id=(scope->>'workspaceId')::uuid AND s.id=(attrs->>'pipeline_stage_id')::uuid AND s.archived_at IS NULL AND p.archived_at IS NULL FOR SHARE OF s,p;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  IF attrs ? 'pipeline_id' AND attrs->>'pipeline_id' IS DISTINCT FROM stage.pipeline_id::text THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
  attrs:=attrs||jsonb_build_object('pipeline_id',stage.pipeline_id,'stage',coalesce(stage.legacy_key,CASE stage.category WHEN 'won' THEN 'won' WHEN 'lost' THEN 'lost' ELSE 'lead' END));
  IF EXISTS(SELECT 1 FROM unnest(stage.required_fields) field WHERE coalesce(attrs->field,attrs->'custom_fields'->field,'null') IN('null'::jsonb,'""'::jsonb)) THEN RAISE EXCEPTION 'invalid_value: required stage fields are missing' USING ERRCODE='22023';END IF;
 END IF;
 params:=jsonb_build_object('kind',p_type,'workspaceId',scope->'workspaceId','displayName',coalesce(input->>'name',CASE WHEN p_type='deal' THEN 'Deal' END),
  'canonicalId',CASE p_type WHEN 'company' THEN attrs->>'domain' WHEN 'person' THEN attrs->>'email' END,'attributes',attrs,'aliases',coalesce(input->'aliases','[]'),
  'createdByUserId',actor,'createdByAssistantId',coalesce(nullif(current_setting('app.application_assistant_id',true),''),scope->>'createdByAssistantId'),'sensitivity',scope->'sensitivity','compartments',scope->'compartments','projectIds',scope->'projectIds');
 SELECT * INTO record_value FROM application_create_canonical_crm_entity(params);
 RETURN jsonb_build_object('workspaceId',record_value.workspace_id,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey',p_type,'id',record_value.id,'version',record_value.scope_version::text);
END $$;
REVOKE ALL ON FUNCTION application_create_canonical_crm_ref(text,jsonb,jsonb) FROM PUBLIC;

-- Physical supersession remains canonical; applications keep one logical identity.
ALTER TABLE tasks ADD COLUMN logical_id uuid;
ALTER TABLE tasks DISABLE TRIGGER canonical_scope_version;
WITH RECURSIVE lineage AS (
 SELECT t.id,t.id AS root,ARRAY[t.id] AS seen FROM tasks t WHERE NOT EXISTS(SELECT 1 FROM tasks p WHERE p.superseded_by=t.id)
 UNION ALL SELECT next.id,l.root,l.seen||next.id FROM lineage l JOIN tasks previous ON previous.id=l.id JOIN tasks next ON next.id=previous.superseded_by WHERE NOT next.id=ANY(l.seen)
) UPDATE tasks t SET logical_id=lineage.root FROM lineage WHERE t.id=lineage.id;
UPDATE tasks SET logical_id=id WHERE logical_id IS NULL;
ALTER TABLE tasks ENABLE TRIGGER canonical_scope_version;
ALTER TABLE tasks ALTER COLUMN logical_id SET NOT NULL;
CREATE INDEX tasks_logical_identity ON tasks(workspace_id,logical_id,scope_version);
CREATE FUNCTION application_task_logical_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.logical_id:=coalesce(NEW.logical_id,NEW.id);
 ELSIF NEW.logical_id IS DISTINCT FROM OLD.logical_id THEN RAISE EXCEPTION 'invalid_value: immutable logical task identity' USING ERRCODE='22023';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_task_logical_identity() FROM PUBLIC;
CREATE TRIGGER application_task_logical_identity BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION application_task_logical_identity();
CREATE FUNCTION application_task_logical_chain_valid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_row tasks;
BEGIN
 SELECT * INTO current_row FROM tasks WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF current_row.logical_id<>current_row.id AND NOT EXISTS(SELECT 1 FROM tasks previous WHERE previous.superseded_by=current_row.id AND previous.logical_id=current_row.logical_id AND previous.workspace_id=current_row.workspace_id)
  OR current_row.superseded_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks next WHERE next.id=current_row.superseded_by AND next.logical_id=current_row.logical_id AND next.workspace_id=current_row.workspace_id)
  OR (SELECT count(*) FROM tasks active WHERE active.workspace_id=current_row.workspace_id AND active.logical_id=current_row.logical_id AND active.valid_to IS NULL AND active.retracted_at IS NULL)>1 THEN
  RAISE EXCEPTION 'record_version_conflict: invalid logical task supersession' USING ERRCODE='40001';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_task_logical_chain_valid() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER application_task_logical_chain_valid AFTER INSERT OR UPDATE OF logical_id,superseded_by,valid_to ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION application_task_logical_chain_valid();
CREATE FUNCTION application_task_live_id(w uuid,p_id uuid) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT live.id FROM tasks live WHERE live.workspace_id=w AND live.logical_id=coalesce((SELECT old.logical_id FROM tasks old WHERE old.id=p_id AND old.workspace_id=w),p_id)
  AND live.valid_to IS NULL AND live.retracted_at IS NULL LIMIT 1
$$;
REVOKE ALL ON FUNCTION application_task_live_id(uuid,uuid) FROM PUBLIC;

ALTER FUNCTION application_resource_fields(uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) RENAME TO application_resource_fields_before_task_identity;
REVOKE ALL ON FUNCTION application_resource_fields_before_task_identity(uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_resource_fields(w uuid,origin jsonb,type_key text,record_id text,owner_id uuid,tier text,teams text[],projects uuid[],row_user uuid,action text,prospective_data jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE logical text:=record_id;logical_owner uuid:=owner_id;
BEGIN
 IF origin='{"kind":"native","moduleKey":"native"}'::jsonb AND type_key='task' THEN
  SELECT t.logical_id::text,root.created_by_user_id INTO logical,logical_owner FROM tasks t JOIN tasks root ON root.id=t.logical_id AND root.workspace_id=t.workspace_id WHERE t.workspace_id=w AND t.id=record_id::uuid;
  logical:=coalesce(logical,record_id);
 END IF;
 RETURN application_resource_fields_before_task_identity(w,origin,type_key,logical,coalesce(logical_owner,owner_id),tier,teams,projects,row_user,action,prospective_data);
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_resource_fields(uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;

-- Grant selectors use stable logical IDs while current field policy reads the
-- live physical metadata. Historical policy remains on its separate port.
DO $migration$
DECLARE definition text;before text:='policy:=public.application_native_field_contract_for(w,origin,type_key,record_id);';
BEGIN
 SELECT pg_get_functiondef('application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb)'::regprocedure) INTO definition;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical module field policy changed';END IF;
 EXECUTE replace(definition,before,$source$policy:=public.application_native_field_contract_for(w,origin,type_key,
  CASE WHEN origin='{"kind":"native","moduleKey":"native"}'::jsonb AND type_key='task'
   THEN coalesce(application_task_live_id(w,record_id::uuid)::text,record_id) ELSE record_id END);$source$);
END $migration$;
ALTER FUNCTION application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) VOLATILE;
ALTER FUNCTION read_native_application_record(uuid,text,uuid,text[]) RENAME TO read_native_application_record_before_task_identity;
REVOKE ALL ON FUNCTION read_native_application_record_before_task_identity(uuid,text,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION read_native_application_record(w uuid,p_type text,p_id uuid,p_fields text[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE physical uuid:=p_id;captured jsonb;
BEGIN
 IF p_type='task' THEN physical:=application_task_live_id(w,p_id);IF physical IS NULL THEN RETURN NULL;END IF;END IF;
 captured:=read_native_application_record_before_task_identity(w,p_type,physical,p_fields);
 IF captured IS NULL THEN RETURN NULL;END IF;
 RETURN captured||jsonb_build_object('id',p_id);
END $$;
REVOKE ALL ON FUNCTION read_native_application_record(uuid,text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_task_patch_state(w uuid,p_id uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r tasks;source jsonb;decision jsonb;command_decision jsonb;context jsonb;policy jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;physical uuid;
BEGIN
 IF actor IS NULL OR fields IS NULL OR cardinality(fields)>128 OR NOT fields<@application_native_field_keys('task')
  OR fields && ARRAY['createdAt','updatedAt'] OR array_position(fields,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class tab ON tab.oid='public.tasks'::regclass WHERE role.rolname=session_user AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,tab.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 PERFORM id FROM workspaces WHERE id=w FOR UPDATE;
 physical:=application_task_live_id(w,p_id);
 SELECT * INTO r FROM tasks WHERE workspace_id=w AND id=physical AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 source:=read_scope_source(w,'task',r.id);
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR scope_review_state_held('task',r.id)
  OR agent_visibility_allows(w,r.user_id,r.assistant_id) IS NOT TRUE OR agent_mutation_scope_allows(r.compartments) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'task',r.id,r.scope_version::text,true) IS NOT TRUE THEN RETURN NULL;END IF;
 context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text OR context->>'readOnly'='true' OR nullif(current_setting('app.application_command_key',true),'') IS NULL THEN RETURN NULL;END IF;
  decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}','task',r.id::text,r.created_by_user_id,r.sensitivity,r.compartments,r.project_ids,r.user_id,'patch');
  command_decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}','task',r.id::text,r.created_by_user_id,r.sensitivity,r.compartments,r.project_ids,r.user_id,'command:'||current_setting('app.application_command_key',true));
  IF decision IS NULL OR command_decision IS NULL OR NOT(to_jsonb(fields)<@(decision->'write') AND to_jsonb(fields)<@(command_decision->'write')) THEN RETURN NULL;END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE
   OR r.user_id IS NOT NULL AND r.user_id<>actor OR member_operation_row_allows(member_principal_operation_grants(actor,true,w),w,r.sensitivity,r.compartments) IS NOT TRUE THEN RETURN NULL;END IF;
  policy:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}','task',r.id);
  IF policy->>'registered' IS DISTINCT FROM 'false' AND (policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR NOT coalesce(to_jsonb(fields)<@(policy->'writeFields'),false)) THEN RETURN NULL;END IF;
 END IF;
 RETURN jsonb_build_object('workspaceId',w,'id',r.logical_id,'physicalId',r.id,'version',r.scope_version::text,'scope',source);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_task_patch_state(uuid,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_patch_canonical_task(w uuid,p_id uuid,patch jsonb,expected_version text DEFAULT NULL,inherited jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fields text[];state jsonb;old tasks;next tasks;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;entry record;key text;
 data jsonb;scope jsonb;physical uuid;parent_scope jsonb;teams text[];projects uuid[];tier text;private_user uuid;private_assistant uuid;
BEGIN
 IF application_native_task_patch_valid(patch) IS NOT TRUE OR patch-ARRAY['title','status','assigneeId','executorAssistantId','followUpMemberId','home','due','tags','parentId','externalRef','attributes']<>'{}' THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
 fields:=ARRAY(SELECT jsonb_object_keys(patch));state:=application_task_patch_state(w,p_id,fields);
 IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF expected_version IS NOT NULL AND (expected_version !~ '^[1-9]\d*$' OR expected_version<>state->>'version') THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';END IF;
 IF patch='{}' AND inherited IS NULL THEN RETURN jsonb_build_object('workspaceId',w,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','task','id',state->'id','version',state->'version');END IF;
 SELECT * INTO old FROM tasks WHERE id=(state->>'physicalId')::uuid;
 data:=to_jsonb(old);teams:=old.compartments;projects:=old.project_ids;tier:=old.sensitivity;private_user:=old.user_id;private_assistant:=old.assistant_id;
 FOR entry IN SELECT * FROM jsonb_each(patch) LOOP
  key:=CASE entry.key WHEN 'assigneeId' THEN 'assignee_id' WHEN 'executorAssistantId' THEN 'executor_assistant_id' WHEN 'followUpMemberId' THEN 'follow_up_member_id'
   WHEN 'parentId' THEN 'parent_id' WHEN 'externalRef' THEN 'external_ref' ELSE entry.key END;
  IF entry.key='home' THEN data:=data||jsonb_build_object('home_kind',entry.value->'kind','home_id',entry.value->'id');
  ELSE data:=data||jsonb_build_object(key,entry.value);END IF;
 END LOOP;
 IF patch->>'assigneeId' IS NOT NULL AND patch->>'executorAssistantId' IS NOT NULL THEN RAISE EXCEPTION 'invalid_value: conflicting task executors' USING ERRCODE='22023';END IF;
 IF patch->>'assigneeId' IS NOT NULL THEN data:=data||jsonb_build_object('executor_assistant_id',NULL);END IF;
 IF patch->>'executorAssistantId' IS NOT NULL THEN data:=data||jsonb_build_object('assignee_id',NULL);END IF;
 IF inherited IS NOT NULL THEN
  IF inherited#>>'{visibility,userId}' IS NOT NULL THEN
   IF private_user IS NOT NULL AND private_user::text<>inherited#>>'{visibility,userId}' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   private_user:=(inherited#>>'{visibility,userId}')::uuid;
  END IF;
  IF inherited#>>'{visibility,assistantId}' IS NOT NULL THEN
   IF private_assistant IS NOT NULL AND private_assistant::text<>inherited#>>'{visibility,assistantId}' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   private_assistant:=(inherited#>>'{visibility,assistantId}')::uuid;
  END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(coalesce(inherited->'compartments','[]')))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(coalesce(inherited->'projectIds','[]'))::uuid)) value ORDER BY value);
  IF sensitivity_rank(inherited->>'sensitivity')>sensitivity_rank(tier) THEN tier:=inherited->>'sensitivity';END IF;
 END IF;
 IF data->>'parent_id' IS NOT NULL THEN
  physical:=application_task_live_id(w,(data->>'parent_id')::uuid);
  IF physical IS NULL OR physical=old.id OR NOT application_field_reference_admitted(w,jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','task','id',physical,'fields','[]'::jsonb)) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  PERFORM id FROM tasks WHERE id=physical FOR SHARE;
  parent_scope:=read_scope_source(w,'task',physical);
  IF parent_scope IS NULL OR parent_scope->>'held' IS DISTINCT FROM 'false'
   OR parent_scope->>'userId' IS NOT NULL AND private_user::text IS DISTINCT FROM parent_scope->>'userId'
   OR parent_scope->>'assistantId' IS NOT NULL AND private_assistant::text IS DISTINCT FROM parent_scope->>'assistantId' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(parent_scope->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(parent_scope->'projectIds')::uuid)) value ORDER BY value);
  IF sensitivity_rank(parent_scope->>'sensitivity')>sensitivity_rank(tier) THEN tier:=parent_scope->>'sensitivity';END IF;
  data:=data||jsonb_build_object('parent_id',physical);
 END IF;
 IF agent_mutation_scope_allows(teams) IS NOT TRUE OR agent_visibility_allows(w,private_user,private_assistant) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF data->>'home_kind' IS NOT NULL AND (data->>'home_kind' IS DISTINCT FROM old.home_kind OR data->>'home_id' IS DISTINCT FROM old.home_id::text)
  AND task_home_admissible(actor,w,data->>'home_kind',(data->>'home_id')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF data->>'executor_assistant_id' IS NOT NULL AND (data->>'executor_assistant_id' IS DISTINCT FROM old.executor_assistant_id::text OR patch ? 'home')
  AND task_executor_eligible(actor,w,(data->>'executor_assistant_id')::uuid,private_assistant,tier,data->>'home_kind',(data->>'home_id')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF data->>'follow_up_member_id' IS NOT NULL AND (data->>'follow_up_member_id' IS DISTINCT FROM old.follow_up_member_id::text OR patch ? 'home')
  AND task_follow_up_eligible(w,(data->>'follow_up_member_id')::uuid,tier,teams,private_user,data->>'home_kind',(data->>'home_id')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF data->>'assignee_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.id=(data->>'assignee_id')::uuid) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 data:=data||jsonb_build_object('id',gen_random_uuid(),'scope_version',old.scope_version+1,'valid_from',clock_timestamp(),'valid_to',NULL,'superseded_by',NULL,
  'created_by_user_id',actor,'updated_at',clock_timestamp(),'sensitivity',tier,'compartments',teams,'project_ids',projects,'user_id',private_user,'assistant_id',private_assistant);
 next:=jsonb_populate_record(NULL::tasks,data);
 INSERT INTO tasks SELECT next.*;
 UPDATE tasks SET valid_to=clock_timestamp(),superseded_by=next.id WHERE id=old.id AND valid_to IS NULL;
 UPDATE tasks SET parent_id=next.id WHERE workspace_id=w AND parent_id=old.id AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held;
 UPDATE goals SET host_id=next.id WHERE workspace_id=w AND host_type='task' AND host_id=old.id;
 PERFORM task_execution_repoint(old.id,next.id);
 WITH copied AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
   SELECT d.workspace_id,d.resource_kind,next.id,next.scope_version::text,d.producer,d.user_id,d.assistant_id,
    next.sensitivity,next.compartments,next.project_ids,d.source_policy_revision FROM scope_derivations d
    WHERE d.workspace_id=w AND d.resource_kind='task' AND d.resource_id=old.id AND d.resource_version=old.scope_version::text
   RETURNING id
 ) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
 SELECT w,copied.id,s.source_kind,s.source_id,s.source_version FROM copied CROSS JOIN scope_derivations original
 JOIN scope_derivation_sources s ON s.derivation_id=original.id AND s.workspace_id=original.workspace_id
 WHERE original.workspace_id=w AND original.resource_kind='task' AND original.resource_id=old.id AND original.resource_version=old.scope_version::text;
 state:=application_task_patch_state(w,next.id,fields);
 IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('workspaceId',w,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','task','id',next.logical_id,'version',next.scope_version::text,'physicalId',next.id);
END $$;
REVOKE ALL ON FUNCTION application_patch_canonical_task(uuid,uuid,jsonb,text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_create_canonical_task(params jsonb) RETURNS SETOF tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb:=application_current_maxima();actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;assistant uuid;
 w uuid;new_id uuid:=gen_random_uuid();tier text;teams text[];projects uuid[];fields text[];parent tasks;private_user uuid;private_assistant uuid;physical_parent uuid;
BEGIN
 w:=(context->>'workspaceId')::uuid;assistant:=nullif(current_setting('app.application_assistant_id',true),'')::uuid;
 IF context IS NULL OR actor IS NULL OR jsonb_typeof(params) IS DISTINCT FROM 'object'
  OR params-ARRAY['workspaceId','title','status','assigneeId','executorAssistantId','followUpMemberId','home','due','tags','parentId','externalRef','attributes','sensitivity','compartments','projectIds','createdByAssistantId']<>'{}'
  OR application_native_task_patch_valid(params) IS NOT TRUE OR params->>'workspaceId' IS DISTINCT FROM w::text OR jsonb_typeof(params->'title') IS DISTINCT FROM 'string' OR length(btrim(params->>'title')) NOT BETWEEN 1 AND 512
  OR params->>'createdByAssistantId' IS NOT NULL AND params->>'createdByAssistantId' IS DISTINCT FROM assistant::text THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
 fields:=ARRAY(SELECT key FROM jsonb_object_keys(params) key WHERE key=ANY(ARRAY['title','status','assigneeId','executorAssistantId','followUpMemberId','home','due','tags','parentId','externalRef','attributes']));
 tier:=coalesce(params->>'sensitivity','internal');teams:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'compartments','[]')));projects:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'projectIds','[]'))::uuid);
 IF params->>'parentId' IS NOT NULL THEN
  physical_parent:=application_task_live_id(w,(params->>'parentId')::uuid);
  IF physical_parent IS NULL OR application_field_reference_admitted(w,jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','task','id',physical_parent,'fields','[]'::jsonb)) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  SELECT * INTO parent FROM tasks WHERE id=physical_parent AND workspace_id=w AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  private_user:=parent.user_id;private_assistant:=parent.assistant_id;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||parent.compartments) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||parent.project_ids) value ORDER BY value);
  IF sensitivity_rank(parent.sensitivity)>sensitivity_rank(tier) THEN tier:=parent.sensitivity;END IF;
 END IF;
 IF cardinality(projects)>1 OR EXISTS(SELECT 1 FROM unnest(projects) id WHERE NOT EXISTS(SELECT 1 FROM workspace_projects p WHERE p.id=id AND p.workspace_id=w AND p.status='active'))
  OR application_native_create_allows('task',new_id,actor,tier,teams,projects,fields,'{}') IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF params->>'assigneeId' IS NOT NULL AND params->>'executorAssistantId' IS NOT NULL THEN RAISE EXCEPTION 'invalid_value: conflicting task executors' USING ERRCODE='22023';END IF;
 IF params->>'assigneeId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.id=(params->>'assigneeId')::uuid) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF params#>>'{home,kind}' IS NOT NULL AND task_home_admissible(actor,w,params#>>'{home,kind}',(params#>>'{home,id}')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF params->>'executorAssistantId' IS NOT NULL AND task_executor_eligible(actor,w,(params->>'executorAssistantId')::uuid,private_assistant,tier,params#>>'{home,kind}',(params#>>'{home,id}')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF params->>'followUpMemberId' IS NOT NULL AND task_follow_up_eligible(w,(params->>'followUpMemberId')::uuid,tier,teams,private_user,params#>>'{home,kind}',(params#>>'{home,id}')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY INSERT INTO tasks(id,logical_id,workspace_id,title,status,created_by_user_id,created_by_assistant_id,sensitivity,compartments,project_ids,source,user_id,assistant_id,
  assignee_id,executor_assistant_id,follow_up_member_id,home_kind,home_id,due,tags,parent_id,external_ref,attributes)
 VALUES(new_id,new_id,w,params->>'title',coalesce(params->>'status','todo'),actor,assistant,tier,teams,projects,'user',private_user,private_assistant,
  (params->>'assigneeId')::uuid,(params->>'executorAssistantId')::uuid,(params->>'followUpMemberId')::uuid,params#>>'{home,kind}',(params#>>'{home,id}')::uuid,
  (params->>'due')::timestamptz,ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'tags','[]'))),physical_parent,coalesce(params->'externalRef','{}'),coalesce(params->'attributes','{}')) RETURNING *;
END $$;
REVOKE ALL ON FUNCTION application_create_canonical_task(jsonb) FROM PUBLIC;

-- FK SET NULL is narrow physical maintenance: each removed responsibility
-- target is actually gone and every other stored value is unchanged.
CREATE FUNCTION application_native_task_fk_maintenance(before_row jsonb,after_row jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text;changed boolean:=false;old_id uuid;
BEGIN
 IF before_row-ARRAY['assignee_id','executor_assistant_id','follow_up_member_id','scope_version','updated_at'] IS DISTINCT FROM after_row-ARRAY['assignee_id','executor_assistant_id','follow_up_member_id','scope_version','updated_at'] THEN RETURN false;END IF;
 FOREACH key IN ARRAY ARRAY['assignee_id','executor_assistant_id','follow_up_member_id'] LOOP
  IF before_row->key IS DISTINCT FROM after_row->key THEN
   IF before_row->>key IS NULL OR after_row->>key IS NOT NULL THEN RETURN false;END IF;
   old_id:=(before_row->>key)::uuid;
   IF key='executor_assistant_id' THEN
    IF EXISTS(SELECT 1 FROM assistants a WHERE a.id=old_id) THEN RETURN false;END IF;
   ELSIF EXISTS(SELECT 1 FROM workspace_members m WHERE m.id=old_id) THEN RETURN false;END IF;
   changed:=true;
  END IF;
 END LOOP;
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION application_native_task_fk_maintenance(jsonb,jsonb) FROM PUBLIC;

-- Existing monotonic policy epochs and catalog/configuration metadata invalidate
-- an old native invocation even when a role or configuration value is restored.
CREATE FUNCTION application_native_task_write_policy_revision(w uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE contract application_native_field_contracts;configuration text;namespace text;procedure_name text;
BEGIN
 SELECT * INTO contract FROM application_native_field_contracts c WHERE c.module_key='native';
 IF contract.configuration_reader IS NOT NULL AND application_native_configuration_port_valid(contract.configuration_reader) THEN
  SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=contract.configuration_reader;
  EXECUTE format('SELECT %I.%I($1)',namespace,procedure_name) INTO configuration USING w;
 END IF;
 RETURN application_field_digest(jsonb_build_object(
  'workspaceEpoch',coalesce((SELECT e.revision::text FROM application_policy_workspace_epochs e WHERE e.workspace_id=w),'0'),
  'contractEpoch',(SELECT e.revision::text FROM application_policy_contract_epoch e),
  'taskCatalog',application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','task'),
  'configuration',configuration,'configurationPort',application_policy_port_fingerprint(contract.configuration_reader),
  'recordPort',application_policy_port_fingerprint(contract.metadata_reader),'catalogPort',application_policy_port_fingerprint(contract.catalog_reader),
  'timedRoles',(SELECT coalesce(jsonb_agg(r.id ORDER BY r.id),'[]') FROM application_native_role_assignments r WHERE r.workspace_id=w AND r.module_key='native'
   AND r.status='active' AND r.starts_at<=clock_timestamp() AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp()))));
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_task_write_policy_revision(uuid) FROM PUBLIC;

-- A restriction-only ledger pins exact write intent until deferred current checks.
-- It contains identifiers/field names only and is inaccessible to app SQL.
CREATE TABLE application_native_task_write_intents (
 transaction_id bigint NOT NULL,backend_pid integer NOT NULL,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 logical_id uuid NOT NULL,physical_id uuid NOT NULL,source_version bigint NOT NULL,action text NOT NULL CHECK(action IN('create','patch')),
 actor_user_id uuid NOT NULL,app_id uuid,assistant_id uuid,v2_assistant_id uuid,application_assistant_id uuid,command_key text,policy_revision text NOT NULL,fields text[] NOT NULL,
 PRIMARY KEY(transaction_id,backend_pid,workspace_id,physical_id,source_version,action)
);
ALTER TABLE application_native_task_write_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_native_task_write_intents FROM PUBLIC;
CREATE FUNCTION application_record_native_task_write_intent(task_row tasks,write_fields text[],write_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;application uuid:=nullif(current_setting('app.application_id',true),'')::uuid;
 acting uuid:=coalesce(nullif(current_setting('app.application_assistant_id',true),'')::uuid,nullif(current_setting('app.v2_assistant_id',true),'')::uuid);
 command text:=nullif(current_setting('app.application_command_key',true),'');revision text;
BEGIN
 IF actor IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=task_row.workspace_id AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='task') AND write_action='create' THEN RETURN;END IF;
  RAISE EXCEPTION 'access_unavailable: a current task actor is required' USING ERRCODE='42501';
 END IF;
 IF write_action NOT IN('create','patch') OR write_fields IS NULL OR array_position(write_fields,NULL) IS NOT NULL
  OR NOT write_fields<@ARRAY['title','status','assigneeId','executorAssistantId','followUpMemberId','home','due','tags','parentId','externalRef','attributes'] THEN RAISE EXCEPTION 'invalid_value: invalid task write intent' USING ERRCODE='22023';END IF;
 revision:=application_native_task_write_policy_revision(task_row.workspace_id);
 IF revision IS NULL THEN RAISE EXCEPTION 'access_unavailable: task policy unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO application_native_task_write_intents(transaction_id,backend_pid,workspace_id,logical_id,physical_id,source_version,action,actor_user_id,app_id,assistant_id,v2_assistant_id,application_assistant_id,command_key,policy_revision,fields)
 VALUES(txid_current(),pg_backend_pid(),task_row.workspace_id,task_row.logical_id,task_row.id,task_row.scope_version,write_action,actor,application,acting,nullif(current_setting('app.v2_assistant_id',true),'')::uuid,nullif(current_setting('app.application_assistant_id',true),'')::uuid,command,revision,
  ARRAY(SELECT DISTINCT unnest(write_fields) ORDER BY 1))
 ON CONFLICT(transaction_id,backend_pid,workspace_id,physical_id,source_version,action) DO UPDATE
 SET fields=ARRAY(SELECT DISTINCT unnest(application_native_task_write_intents.fields||EXCLUDED.fields) ORDER BY 1)
 WHERE application_native_task_write_intents.actor_user_id=EXCLUDED.actor_user_id
  AND application_native_task_write_intents.app_id IS NOT DISTINCT FROM EXCLUDED.app_id
  AND application_native_task_write_intents.assistant_id IS NOT DISTINCT FROM EXCLUDED.assistant_id
  AND application_native_task_write_intents.v2_assistant_id IS NOT DISTINCT FROM EXCLUDED.v2_assistant_id
  AND application_native_task_write_intents.application_assistant_id IS NOT DISTINCT FROM EXCLUDED.application_assistant_id
  AND application_native_task_write_intents.command_key IS NOT DISTINCT FROM EXCLUDED.command_key
  AND application_native_task_write_intents.policy_revision=EXCLUDED.policy_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable: task identity changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION application_record_native_task_write_intent(tasks,text[],text) FROM PUBLIC;
CREATE FUNCTION application_record_native_task_insert_intent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior tasks;before_values jsonb:='{}';after_values jsonb;write_fields text[];intent jsonb:=nullif(current_setting('app.native_task_write_intent',true),'')::jsonb;write_action text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=NEW.workspace_id) THEN RETURN NULL;END IF;
 after_values:=application_native_task_values(to_jsonb(NEW))-ARRAY['createdAt','updatedAt','sourceEpisodeId','sourceStartMs','verified','createdByUserId','createdByAssistantId','source','sourceSessionId'];
 IF NEW.id=NEW.logical_id THEN write_action:='create';
 ELSE
  write_action:='patch';SELECT t.* INTO prior FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.logical_id=NEW.logical_id AND t.id<>NEW.id AND t.valid_to IS NULL ORDER BY t.scope_version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable: canonical task predecessor missing' USING ERRCODE='42501';END IF;
  before_values:=application_native_task_values(to_jsonb(prior))-ARRAY['createdAt','updatedAt','sourceEpisodeId','sourceStartMs','verified','createdByUserId','createdByAssistantId','source','sourceSessionId'];
 END IF;
 write_fields:=ARRAY(SELECT key FROM jsonb_object_keys(after_values) key WHERE before_values->key IS DISTINCT FROM after_values->key);
 IF write_action='create' THEN
  write_fields:=ARRAY(SELECT key FROM unnest(write_fields) key WHERE after_values->key<>'null'::jsonb
   AND NOT(key='tags' AND after_values->key='[]'::jsonb) AND NOT(key IN('externalRef','attributes') AND after_values->key='{}'::jsonb) AND NOT(key='status' AND after_values->key='"todo"'::jsonb));
 END IF;
 IF intent->>'workspaceId'=NEW.workspace_id::text AND intent->>'logicalId'=NEW.logical_id::text AND jsonb_typeof(intent->'fields')='array' THEN
  write_fields:=ARRAY(SELECT DISTINCT unnest(write_fields||ARRAY(SELECT jsonb_array_elements_text(intent->'fields'))) ORDER BY 1);
 END IF;
 PERFORM application_record_native_task_write_intent(NEW,write_fields,write_action);RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_record_native_task_insert_intent() FROM PUBLIC;
CREATE TRIGGER application_native_task_insert_intent AFTER INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION application_record_native_task_insert_intent();
CREATE FUNCTION application_force_native_task_written_field() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;key text:=TG_ARGV[0];
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=NEW.workspace_id) THEN RETURN NEW;END IF;
 IF key IN('assigneeId','executorAssistantId','followUpMemberId') AND application_native_task_fk_maintenance(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
 IF key='parentId' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id
  AND application_native_task_values(to_jsonb(OLD))->'parentId'=application_native_task_values(to_jsonb(NEW))->'parentId'
  AND EXISTS(SELECT 1 FROM tasks prior JOIN tasks next ON next.workspace_id=prior.workspace_id AND next.logical_id=prior.logical_id AND next.id=prior.superseded_by
   WHERE prior.workspace_id=NEW.workspace_id AND prior.id=OLD.parent_id AND next.id=NEW.parent_id AND prior.valid_to IS NOT NULL AND next.valid_to IS NULL AND next.retracted_at IS NULL) THEN RETURN NEW;END IF;
 state:=application_task_patch_state(OLD.workspace_id,OLD.id,CASE WHEN key='' THEN '{}'::text[] ELSE ARRAY[key] END);
 IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable: canonical task field unavailable' USING ERRCODE='42501';END IF;
 IF NEW.scope_version=OLD.scope_version THEN NEW.scope_version:=OLD.scope_version+1;NEW.updated_at:=clock_timestamp();END IF;
 PERFORM application_record_native_task_write_intent(NEW,CASE WHEN key='' THEN '{}'::text[] ELSE ARRAY[key] END,'patch');RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_force_native_task_written_field() FROM PUBLIC;
DO $migration$
DECLARE entry record;
BEGIN
 FOR entry IN SELECT * FROM (VALUES('title','title'),('status','status'),('assignee_id','assigneeId'),('executor_assistant_id','executorAssistantId'),
  ('follow_up_member_id','followUpMemberId'),('user_id',''),('assistant_id',''),('sensitivity',''),('compartments',''),('project_ids',''),('home_kind','home'),('home_id','home'),('due','due'),('tags','tags'),('parent_id','parentId'),('external_ref','externalRef'),('attributes','attributes')) fields(column_name,field_key) LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF %I ON tasks FOR EACH ROW EXECUTE FUNCTION application_force_native_task_written_field(%L)','zz_application_task_field_'||entry.column_name,entry.column_name,entry.field_key);
 END LOOP;
END $migration$;
CREATE FUNCTION application_recheck_native_task_write_intent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pending application_native_task_write_intents;stored tasks;live tasks;state jsonb;policy jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;application uuid:=nullif(current_setting('app.application_id',true),'')::uuid;
 acting uuid:=coalesce(nullif(current_setting('app.application_assistant_id',true),'')::uuid,nullif(current_setting('app.v2_assistant_id',true),'')::uuid);
 command text:=nullif(current_setting('app.application_command_key',true),'');
BEGIN
 SELECT * INTO pending FROM application_native_task_write_intents i WHERE i.transaction_id=NEW.transaction_id AND i.backend_pid=NEW.backend_pid
  AND i.workspace_id=NEW.workspace_id AND i.physical_id=NEW.physical_id AND i.source_version=NEW.source_version AND i.action=NEW.action;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF pending.transaction_id<>txid_current() OR pending.backend_pid<>pg_backend_pid() OR pending.actor_user_id IS DISTINCT FROM actor
  OR pending.app_id IS DISTINCT FROM application OR pending.assistant_id IS DISTINCT FROM acting
  OR pending.v2_assistant_id IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')::uuid
  OR pending.application_assistant_id IS DISTINCT FROM nullif(current_setting('app.application_assistant_id',true),'')::uuid OR pending.command_key IS DISTINCT FROM command THEN RAISE EXCEPTION 'access_unavailable: task operation identity changed' USING ERRCODE='42501';END IF;
 SELECT * INTO stored FROM tasks t WHERE t.workspace_id=pending.workspace_id AND t.id=pending.physical_id;
 IF FOUND THEN
  IF stored.logical_id<>pending.logical_id OR stored.scope_version<pending.source_version THEN RAISE EXCEPTION 'access_unavailable: task source identity changed' USING ERRCODE='42501';END IF;
  SELECT * INTO live FROM tasks t WHERE t.workspace_id=pending.workspace_id AND t.id=application_task_live_id(pending.workspace_id,pending.logical_id);
  IF FOUND THEN
   -- Current role rows are retained only after the deferred recheck; this is a
   -- lock against a concurrent contraction, never a saved permission result.
   PERFORM 1 FROM application_native_role_assignments r WHERE r.workspace_id=pending.workspace_id AND r.module_key='native' AND r.status='active' FOR SHARE;
   IF pending.policy_revision IS DISTINCT FROM application_native_task_write_policy_revision(pending.workspace_id) THEN RAISE EXCEPTION 'access_unavailable: task policy changed' USING ERRCODE='42501';END IF;
   IF pending.action='patch' THEN
    state:=application_task_patch_state(pending.workspace_id,live.id,pending.fields);
    IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable: task field authority changed' USING ERRCODE='42501';END IF;
   ELSIF application IS NOT NULL THEN
    IF application_native_creation_ref('task',live.id,pending.fields) IS NULL THEN RAISE EXCEPTION 'access_unavailable: task creation authority changed' USING ERRCODE='42501';END IF;
   ELSE
    IF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=pending.workspace_id AND m.user_id=actor)
     OR workflow_evidence_envelope_visible(pending.workspace_id,read_scope_source(pending.workspace_id,'task',live.id)) IS NOT TRUE
     OR member_operation_row_allows(member_principal_operation_grants(actor,true,pending.workspace_id),pending.workspace_id,live.sensitivity,live.compartments) IS NOT TRUE
     OR agent_mutation_scope_allows(live.compartments) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: task creation authority changed' USING ERRCODE='42501';END IF;
    policy:=application_current_native_field_policy(pending.workspace_id,'{"kind":"native","moduleKey":"native"}','task',live.id);
    IF policy->>'registered' IS DISTINCT FROM 'false' AND (policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR NOT coalesce(to_jsonb(pending.fields)<@(policy->'writeFields'),false)) THEN RAISE EXCEPTION 'access_unavailable: task creation fields changed' USING ERRCODE='42501';END IF;
   END IF;
   IF application_canonical_ancestry_allowed(pending.workspace_id,'task',live.id,live.scope_version::text,true) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: task source authority changed' USING ERRCODE='42501';END IF;
  END IF;
 END IF;
 DELETE FROM application_native_task_write_intents i WHERE i.transaction_id=pending.transaction_id AND i.backend_pid=pending.backend_pid
  AND i.workspace_id=pending.workspace_id AND i.physical_id=pending.physical_id AND i.source_version=pending.source_version AND i.action=pending.action;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_recheck_native_task_write_intent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER application_native_task_written_fields_commit AFTER INSERT OR UPDATE ON application_native_task_write_intents
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION application_recheck_native_task_write_intent();

-- Task field/source restrictions cover raw/legacy writers as well as adapters.
CREATE FUNCTION application_guard_canonical_task_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous tasks;source jsonb;before_values jsonb:='{}';after_values jsonb;fields text[];state jsonb;intent jsonb;parent_scope jsonb;parent tasks;
 policy jsonb;context jsonb;decision jsonb;command_decision jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;kind text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=NEW.workspace_id) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
  IF application_native_task_fk_maintenance(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
  previous:=OLD;
  IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.logical_id<>OLD.logical_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_by_assistant_id IS DISTINCT FROM OLD.created_by_assistant_id THEN RAISE EXCEPTION 'invalid_value: immutable canonical task identity' USING ERRCODE='22023';END IF;
 ELSIF NEW.logical_id<>NEW.id THEN
  SELECT * INTO previous FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.logical_id=NEW.logical_id AND t.valid_to IS NULL AND t.retracted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.retracted_at IS NOT DISTINCT FROM OLD.retracted_at AND (NEW.source IS DISTINCT FROM OLD.source
  OR NEW.source_episode_id IS DISTINCT FROM OLD.source_episode_id OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
  OR NEW.source_start_ms IS DISTINCT FROM OLD.source_start_ms) THEN RAISE EXCEPTION 'invalid_value: immutable task provenance' USING ERRCODE='22023';END IF;
 IF NEW.due IS NOT NULL AND NOT isfinite(NEW.due) OR application_native_task_patch_valid(application_native_task_values(to_jsonb(NEW))) IS NOT TRUE THEN RAISE EXCEPTION 'invalid_value: invalid canonical task values' USING ERRCODE='22023';END IF;
 after_values:=application_native_task_values(to_jsonb(NEW))-ARRAY['createdAt','updatedAt','sourceEpisodeId','sourceStartMs','verified','createdByUserId','createdByAssistantId','source','sourceSessionId'];
 IF previous.id IS NOT NULL THEN before_values:=application_native_task_values(to_jsonb(previous))-ARRAY['createdAt','updatedAt','sourceEpisodeId','sourceStartMs','verified','createdByUserId','createdByAssistantId','source','sourceSessionId'];END IF;
 IF TG_OP='UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id AND before_values->'parentId'=after_values->'parentId' THEN
  -- A stable logical parent can only change its physical pointer along the
  -- exact canonical supersession edge, never to an arbitrary retired alias.
  IF NOT EXISTS(SELECT 1 FROM tasks prior JOIN tasks next ON next.workspace_id=prior.workspace_id AND next.logical_id=prior.logical_id AND next.id=prior.superseded_by
   WHERE prior.workspace_id=NEW.workspace_id AND prior.id=OLD.parent_id AND next.id=NEW.parent_id AND prior.valid_to IS NOT NULL AND next.valid_to IS NULL AND next.retracted_at IS NULL) THEN RAISE EXCEPTION 'access_unavailable: invalid task parent maintenance' USING ERRCODE='42501';END IF;
 END IF;
 IF NEW.parent_id IS NOT NULL AND (previous.id IS NULL OR before_values->'parentId' IS DISTINCT FROM after_values->'parentId') THEN
  SELECT * INTO parent FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.parent_id AND t.valid_to IS NULL AND t.retracted_at IS NULL AND NOT t.scope_held FOR SHARE;
  IF NOT FOUND OR parent.logical_id=NEW.logical_id OR application_field_reference_admitted(NEW.workspace_id,jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','task','id',NEW.parent_id,'fields','[]'::jsonb)) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: parent_id must reference a task in the same workspace' USING ERRCODE='42501';END IF;
  parent_scope:=read_scope_source(NEW.workspace_id,'task',parent.id);
  IF parent_scope IS NULL OR parent_scope->>'held' IS DISTINCT FROM 'false' OR sensitivity_rank(parent.sensitivity)>sensitivity_rank(NEW.sensitivity)
   OR NOT parent.compartments<@NEW.compartments OR NOT parent.project_ids<@NEW.project_ids
   OR parent.user_id IS NOT NULL AND parent.user_id IS DISTINCT FROM NEW.user_id OR parent.assistant_id IS NOT NULL AND parent.assistant_id IS DISTINCT FROM NEW.assistant_id THEN RAISE EXCEPTION 'access_unavailable: task parent floor unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF NEW.home_kind IS NOT NULL AND (previous.id IS NULL OR NEW.home_kind IS DISTINCT FROM previous.home_kind OR NEW.home_id IS DISTINCT FROM previous.home_id) THEN
  IF NEW.home_kind='project' AND cardinality(NEW.project_ids)>0 AND NOT NEW.home_id=ANY(NEW.project_ids)
   OR task_home_admissible(actor,NEW.workspace_id,NEW.home_kind,NEW.home_id) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: task home unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF NEW.executor_assistant_id IS NOT NULL AND (previous.id IS NULL OR NEW.executor_assistant_id IS DISTINCT FROM previous.executor_assistant_id OR NEW.home_kind IS DISTINCT FROM previous.home_kind OR NEW.home_id IS DISTINCT FROM previous.home_id)
  AND task_executor_eligible(actor,NEW.workspace_id,NEW.executor_assistant_id,NEW.assistant_id,NEW.sensitivity,NEW.home_kind,NEW.home_id) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: task executor unavailable' USING ERRCODE='42501';END IF;
 IF NEW.follow_up_member_id IS NOT NULL AND (previous.id IS NULL OR NEW.follow_up_member_id IS DISTINCT FROM previous.follow_up_member_id OR NEW.home_kind IS DISTINCT FROM previous.home_kind OR NEW.home_id IS DISTINCT FROM previous.home_id)
  AND task_follow_up_eligible(NEW.workspace_id,NEW.follow_up_member_id,NEW.sensitivity,NEW.compartments,NEW.user_id,NEW.home_kind,NEW.home_id) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: task follow-up unavailable' USING ERRCODE='42501';END IF;
 fields:=ARRAY(SELECT key FROM (SELECT jsonb_object_keys(before_values) AS key UNION SELECT jsonb_object_keys(after_values)) keys WHERE before_values->key IS DISTINCT FROM after_values->key);
 intent:=nullif(current_setting('app.native_task_write_intent',true),'')::jsonb;
 IF intent->>'workspaceId'=NEW.workspace_id::text AND intent->>'logicalId'=NEW.logical_id::text AND jsonb_typeof(intent->'fields')='array' THEN
  fields:=ARRAY(SELECT DISTINCT unnest(fields||ARRAY(SELECT jsonb_array_elements_text(intent->'fields'))) ORDER BY 1);
 END IF;
 IF previous.id IS NOT NULL THEN
  IF cardinality(fields)=0 THEN RETURN NEW;END IF;
  state:=application_task_patch_state(NEW.workspace_id,previous.id,fields);
  IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable: canonical task fields unavailable' USING ERRCODE='42501';END IF;
 ELSE
  -- Omitted fixed defaults are not caller writes. Explicit typed intents are
  -- retained above, including same-value writes to these defaults.
  fields:=ARRAY(SELECT field FROM unnest(fields) field WHERE after_values->field<>'null'::jsonb
   AND NOT(field IN('tags') AND after_values->field='[]'::jsonb)
   AND NOT(field IN('externalRef','attributes') AND after_values->field='{}'::jsonb)
   AND NOT(field='status' AND after_values->field='"todo"'::jsonb))
   ||CASE WHEN intent->>'workspaceId'=NEW.workspace_id::text AND intent->>'logicalId'=NEW.logical_id::text THEN ARRAY(SELECT jsonb_array_elements_text(intent->'fields')) ELSE '{}'::text[] END;
  context:=application_current_maxima();
  IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
   IF context IS NULL OR application_native_create_allows('task',NEW.id,NEW.created_by_user_id,NEW.sensitivity,NEW.compartments,NEW.project_ids,fields,'{}') IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  ELSE
   policy:=application_native_field_catalog_for(NEW.workspace_id,'{"kind":"native","moduleKey":"native"}','task');
   IF policy->>'registered' IS DISTINCT FROM 'false' THEN
    IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
    policy:=read_native_application_field_catalog(NEW.workspace_id,'{"kind":"native","moduleKey":"native"}','task');
    IF policy IS NULL OR NOT coalesce(to_jsonb(fields)<@(policy->'writeFields'),false) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_guard_canonical_task_fields() FROM PUBLIC;
CREATE TRIGGER application_guard_canonical_task_fields BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION application_guard_canonical_task_fields();
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('application_patch_canonical_task(uuid,uuid,jsonb,text,jsonb)'::regprocedure) INTO definition;
 before:='INSERT INTO tasks SELECT next.*;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical task write changed';END IF;
 EXECUTE replace(definition,before,$source$PERFORM set_config('app.native_task_write_intent',jsonb_build_object('workspaceId',w,'logicalId',next.logical_id,'fields',fields)::text,true);
 INSERT INTO tasks SELECT next.*;
 PERFORM set_config('app.native_task_write_intent','',true);$source$);
 SELECT pg_get_functiondef('application_create_canonical_task(jsonb)'::regprocedure) INTO definition;
 before:='RETURN QUERY INSERT INTO tasks(id,logical_id';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical task creation changed';END IF;
 definition:=replace(definition,before,$source$PERFORM set_config('app.native_task_write_intent',jsonb_build_object('workspaceId',w,'logicalId',new_id,'fields',fields)::text,true);
 RETURN QUERY INSERT INTO tasks(id,logical_id$source$);
 before:=$source$coalesce(params->'attributes','{}')) RETURNING *;$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical task creation result changed';END IF;
 EXECUTE replace(definition,before,before||$source$
 PERFORM set_config('app.native_task_write_intent','',true);$source$);
END $migration$;

CREATE FUNCTION application_recheck_native_task_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE physical uuid;version text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=NEW.workspace_id) THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND application_native_task_fk_maintenance(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['scope_held','scope_version','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['scope_held','scope_version','updated_at'])
  AND (NEW.scope_held IS DISTINCT FROM OLD.scope_held OR NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) THEN RETURN NULL;END IF;
 physical:=application_task_live_id(NEW.workspace_id,NEW.logical_id);
 IF physical IS NULL THEN RETURN NULL;END IF;
 SELECT t.scope_version::text INTO version FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=physical;
 IF application_canonical_ancestry_allowed(NEW.workspace_id,'task',physical,version,true) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: task source authority changed' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_recheck_native_task_sources() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER application_native_task_source_commit AFTER INSERT OR UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION application_recheck_native_task_sources();

CREATE FUNCTION application_capture_native_task_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF application_native_task_fk_maintenance(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NULL;END IF;
 IF OLD.valid_to IS NULL AND NEW.valid_to IS NULL AND OLD.retracted_at IS NOT DISTINCT FROM NEW.retracted_at
  AND (application_native_task_values(to_jsonb(OLD))-ARRAY['createdAt','updatedAt','verified'] IS DISTINCT FROM application_native_task_values(to_jsonb(NEW))-ARRAY['createdAt','updatedAt','verified']
   OR EXISTS(SELECT 1 FROM application_native_task_write_intents i WHERE i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.workspace_id=NEW.workspace_id AND i.physical_id=NEW.id AND i.source_version=NEW.scope_version AND i.action='patch' AND cardinality(i.fields)>0)) THEN
  INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor,mutation_reason,sensitivity,workspace_id)
   SELECT 'task',OLD.id,coalesce(max(v.version_no),0)+1,to_jsonb(OLD),coalesce(max(v.valid_to),OLD.valid_from),clock_timestamp(),
    CASE WHEN nullif(current_setting('app.application_id',true),'') IS NULL THEN 'human_edit' ELSE 'assistant_turn' END,'native.task.patch',OLD.sensitivity,OLD.workspace_id
    FROM brain_row_versions v WHERE v.primitive='task' AND v.row_id=OLD.id;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_capture_native_task_revision() FROM PUBLIC;
CREATE TRIGGER application_native_task_revision AFTER UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION application_capture_native_task_revision();

-- A legacy/raw mutation gets the same reference-only receipt/audit/outbox at
-- commit. A dispatcher receipt already carrying that exact version is reused.
CREATE FUNCTION application_record_canonical_native_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref jsonb;refs jsonb;receipt uuid;actor uuid;type_key text;version text;resource_id uuid;canonical_event_key text;creation boolean;tx text:=(pg_current_xact_id()::text::numeric%4294967296)::text;
BEGIN
 IF TG_TABLE_NAME='entities' THEN
  IF NEW.kind NOT IN('company','person','deal') OR TG_OP='UPDATE' AND (NEW.retracted_at IS DISTINCT FROM OLD.retracted_at
   OR NEW.scope_version IS NOT DISTINCT FROM OLD.scope_version
   OR NEW.display_name IS NOT DISTINCT FROM OLD.display_name AND NEW.canonical_id IS NOT DISTINCT FROM OLD.canonical_id
    AND NEW.aliases IS NOT DISTINCT FROM OLD.aliases AND NEW.attributes IS NOT DISTINCT FROM OLD.attributes AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) THEN RETURN NULL;END IF;
  type_key:=NEW.kind;resource_id:=NEW.id;creation:=TG_OP='INSERT';
 ELSE
  IF TG_OP='UPDATE' AND application_native_task_fk_maintenance(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NULL;END IF;
  IF TG_OP='UPDATE' AND (NEW.valid_to IS DISTINCT FROM OLD.valid_to OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
   OR NEW.retracted_at IS DISTINCT FROM OLD.retracted_at OR NEW.scope_version IS NOT DISTINCT FROM OLD.scope_version
   OR application_native_task_values(to_jsonb(NEW))-ARRAY['createdAt','updatedAt','verified'] IS NOT DISTINCT FROM application_native_task_values(to_jsonb(OLD))-ARRAY['createdAt','updatedAt','verified'] AND NOT EXISTS(SELECT 1 FROM brain_row_versions v WHERE v.primitive='task' AND v.row_id=NEW.id AND v.before_image->>'scope_version'=OLD.scope_version::text AND v.xmin::text=tx)) THEN RETURN NULL;END IF;
  type_key:='task';resource_id:=NEW.logical_id;creation:=TG_OP='INSERT' AND NEW.logical_id=NEW.id;
 END IF;
 actor:=coalesce(nullif(current_setting('app.current_user_id',true),'')::uuid,NEW.created_by_user_id);
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=actor) THEN RETURN NULL;END IF;
 version:=NEW.scope_version::text;
 ref:=jsonb_build_object('workspaceId',NEW.workspace_id,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey',type_key,'id',resource_id,'version',version);refs:=jsonb_build_array(ref);
 canonical_event_key:='native.'||type_key||CASE WHEN creation THEN '.created' ELSE '.patched' END;
 -- Reuse only a coherent complete bundle in this actor/application and inserting
 -- transaction. These compiled event keys mirror the native typed registry;
 -- contact keeps its established public event name and mixed commands share one
 -- record event. An unrelated key/module/audit cannot stand in for this effect.
 IF EXISTS(SELECT 1 FROM application_operation_receipts r
  JOIN application_command_audit a ON a.receipt_id=r.id AND a.actor_user_id=r.actor_user_id
   AND a.workspace_id=r.workspace_id AND a.module_key=r.module_key AND a.operation_key=r.operation_key
  JOIN application_committed_events e ON e.receipt_id=r.id AND e.workspace_id=r.workspace_id AND e.module_key=r.module_key AND e.resources=r.resources
  WHERE r.workspace_id=NEW.workspace_id AND r.module_key='native' AND r.actor_user_id=actor AND r.resources @> refs
   AND r.application_client_id IS NOT DISTINCT FROM nullif(current_setting('app.application_id',true),'')::uuid
   AND (e.event_key=canonical_event_key OR e.event_key=CASE
    WHEN creation AND type_key='company' AND r.operation_key='create_company' THEN 'native.company.created'
    WHEN creation AND type_key='person' AND r.operation_key='create_contact' THEN 'native.contact.created'
    WHEN creation AND type_key='deal' AND r.operation_key='create_deal' THEN 'native.deal.created'
    WHEN creation AND type_key='task' AND r.operation_key='create_task' THEN 'native.task.created'
    WHEN NOT creation AND type_key='company' AND r.operation_key IN('patch_company','patch_companies') THEN 'native.company.patched'
    WHEN NOT creation AND type_key='person' AND r.operation_key='patch_contact' THEN 'native.contact.patched'
    WHEN NOT creation AND type_key='deal' AND r.operation_key='patch_deal' THEN 'native.deal.patched'
    WHEN NOT creation AND type_key='task' AND r.operation_key='patch_task' THEN 'native.task.patched'
    WHEN NOT creation AND type_key IN('company','person','deal') AND r.operation_key IN('patch_records','set_custom_fields') THEN 'native.record.patched'
    WHEN NOT creation AND type_key IN('company','person','deal') AND r.operation_key='archive_record' THEN 'native.record.archived'
    WHEN NOT creation AND type_key IN('company','person','deal') AND r.operation_key='set_relationship' THEN 'native.record.relationship_changed'
    WHEN NOT creation AND type_key='deal' AND r.operation_key IN('set_deal_stage','move_deal') THEN 'native.deal.stage_changed'
    WHEN NOT creation AND type_key='deal' AND r.operation_key IN('add_deal_participant','remove_deal_participant','set_primary_contact') THEN 'native.deal.participants_changed'
    ELSE NULL END)
   AND r.xmin::text=tx AND a.xmin::text=tx AND e.xmin::text=tx) THEN RETURN NULL;END IF;
 receipt:=gen_random_uuid();
 INSERT INTO application_operation_receipts(id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources)
 VALUES(receipt,NEW.workspace_id,'native','canonical.'||type_key||CASE WHEN creation THEN '.created' ELSE '.patched' END,
  'canonical:'||actor::text,actor,type_key||':'||resource_id::text||':'||version,application_field_digest(ref),refs)
 ON CONFLICT(workspace_id,module_key,operation_key,actor_key,idempotency_key) DO NOTHING;
 IF NOT FOUND THEN RETURN NULL;END IF;
 INSERT INTO application_command_audit(receipt_id,workspace_id,module_key,actor_user_id,operation_key)
 VALUES(receipt,NEW.workspace_id,'native',actor,'canonical.'||type_key||CASE WHEN creation THEN '.created' ELSE '.patched' END);
 INSERT INTO application_committed_events(receipt_id,workspace_id,module_key,event_key,resources) VALUES(receipt,NEW.workspace_id,'native',canonical_event_key,refs);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_record_canonical_native_effect() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER application_canonical_native_entity_effect AFTER INSERT OR UPDATE ON entities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION application_record_canonical_native_effect();
CREATE CONSTRAINT TRIGGER application_canonical_native_task_effect AFTER INSERT OR UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION application_record_canonical_native_effect();

CREATE FUNCTION application_touch_native_crm_participants(w uuid,deal_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;previous_intent text;tx text:=(pg_current_xact_id()::text::numeric%4294967296)::text;
BEGIN
 state:=application_crm_patch_state('deal',deal_id,ARRAY['participants']);
 IF state IS NULL OR state->>'workspaceId' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 -- Primary-contact and participant representations are one semantic edit.
 IF EXISTS(SELECT 1 FROM brain_row_versions v WHERE v.primitive='entity' AND v.row_id=deal_id AND v.xmin::text=tx)
  OR EXISTS(SELECT 1 FROM entities e WHERE e.id=deal_id AND e.created_at>=transaction_timestamp() AND e.xmin::text=tx) THEN RETURN;END IF;
 previous_intent:=coalesce(current_setting('app.native_entity_write_intent',true),'');
 PERFORM set_config('app.native_entity_write_intent',jsonb_build_object('workspaceId',w,'typeKey','deal','id',deal_id,'fields',ARRAY['participants'])::text,true);
 UPDATE entities SET updated_at=clock_timestamp() WHERE workspace_id=w AND id=deal_id;
 PERFORM set_config('app.native_entity_write_intent',previous_intent,true);
END $$;
REVOKE ALL ON FUNCTION application_touch_native_crm_participants(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION application_guard_native_crm_participant_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_value crm_deal_contacts;contact entities;state jsonb;
BEGIN
 IF TG_OP='DELETE' THEN row_value:=OLD;ELSE row_value:=NEW;END IF;
 -- Workspace cascade/erasure is not a business mutation or a new content copy.
 IF NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=row_value.workspace_id) OR NOT EXISTS(SELECT 1 FROM entities e WHERE e.id=row_value.deal_id) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.deal_id<>OLD.deal_id OR NEW.contact_id<>OLD.contact_id) THEN RAISE EXCEPTION 'invalid_value: immutable canonical relationship identity' USING ERRCODE='22023';END IF;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW;END IF;
 IF TG_OP<>'DELETE' THEN
  SELECT * INTO contact FROM entities e WHERE e.workspace_id=row_value.workspace_id AND e.id=row_value.contact_id AND e.kind='person'
   AND e.valid_to IS NULL AND e.retracted_at IS NULL AND NOT e.scope_held AND e.attributes->>'crm_archived_at' IS NULL AND NOT coalesce((e.attributes->>'self')::boolean,false) FOR SHARE;
  IF NOT FOUND OR application_field_reference_admitted(row_value.workspace_id,jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),
   'typeKey','person','id',row_value.contact_id,'fields','[]'::jsonb)) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  state:=application_crm_patch_state('deal',row_value.deal_id,ARRAY['participants']);
  IF state IS NULL OR state->>'workspaceId' IS DISTINCT FROM row_value.workspace_id::text
   OR contact.user_id IS NOT NULL AND state#>>'{scope,userId}' IS DISTINCT FROM contact.user_id::text
   OR contact.assistant_id IS NOT NULL AND state#>>'{scope,assistantId}' IS DISTINCT FROM contact.assistant_id::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  PERFORM application_patch_canonical_crm('deal',row_value.deal_id,'{}',state->>'version',jsonb_build_object('sensitivity',contact.sensitivity,'compartments',contact.compartments,'projectIds',contact.project_ids));
 END IF;
 PERFORM application_touch_native_crm_participants(row_value.workspace_id,row_value.deal_id);
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_crm_participant_change() FROM PUBLIC;
CREATE TRIGGER application_native_crm_participant_change BEFORE INSERT OR UPDATE OR DELETE ON crm_deal_contacts FOR EACH ROW EXECUTE FUNCTION application_guard_native_crm_participant_change();

CREATE FUNCTION application_native_task_identity(w uuid,p_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE physical uuid;logical uuid;
BEGIN
 physical:=application_task_live_id(w,p_id);IF physical IS NULL THEN RETURN NULL;END IF;
 IF read_native_application_record(w,'task',p_id,'{}') IS NULL THEN RETURN NULL;END IF;
 SELECT t.logical_id INTO logical FROM tasks t WHERE t.workspace_id=w AND t.id=physical;
 RETURN logical;
END $$;
REVOKE ALL ON FUNCTION application_native_task_identity(uuid,uuid) FROM PUBLIC;
ALTER FUNCTION application_native_creation_ref(text,uuid,text[]) RENAME TO application_native_creation_ref_before_task_identity;
REVOKE ALL ON FUNCTION application_native_creation_ref_before_task_identity(text,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_native_creation_ref(type_key text,record_id uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;physical uuid;logical uuid;ref jsonb;
BEGIN
 IF type_key<>'task' THEN RETURN application_native_creation_ref_before_task_identity(type_key,record_id,fields);END IF;
 context:=application_current_maxima();IF context IS NULL THEN RETURN NULL;END IF;
 physical:=application_task_live_id((context->>'workspaceId')::uuid,record_id);
 IF physical IS NULL THEN RETURN NULL;END IF;
 ref:=application_native_creation_ref_before_task_identity(type_key,physical,fields);
 IF ref IS NULL THEN RETURN NULL;END IF;
 SELECT logical_id INTO logical FROM tasks WHERE id=physical AND workspace_id=(context->>'workspaceId')::uuid;
 RETURN ref||jsonb_build_object('id',logical);
END $$;
REVOKE ALL ON FUNCTION application_native_creation_ref(text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_mutate_canonical_deal_participant(w uuid,deal_id uuid,contact_id uuid,operation text,participant_role text,is_primary boolean,expected_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;fields text[];deal entities;contact entities;floor jsonb;ref jsonb;
BEGIN
 IF operation NOT IN('add','remove','primary') OR participant_role IS NOT NULL AND length(participant_role)>200
  OR operation<>'primary' AND contact_id IS NULL THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
 fields:=ARRAY['participants']||CASE WHEN operation IN('remove','primary') OR is_primary THEN ARRAY['contactId'] ELSE '{}'::text[] END;
 state:=application_crm_patch_state('deal',deal_id,fields);
 IF state IS NULL OR state->>'workspaceId' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF expected_version IS NULL OR expected_version !~ '^[1-9]\d*$' OR expected_version<>state->>'version' THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';END IF;
 SELECT * INTO deal FROM entities WHERE id=deal_id AND workspace_id=w;
 IF contact_id IS NOT NULL THEN
  SELECT * INTO contact FROM entities WHERE id=contact_id AND workspace_id=w AND kind='person' AND valid_to IS NULL AND retracted_at IS NULL
   AND NOT scope_held AND NOT coalesce((attributes->>'self')::boolean,false) AND attributes->>'crm_archived_at' IS NULL FOR SHARE;
  IF NOT FOUND OR application_field_reference_admitted(w,jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','person','id',contact_id,'fields','[]'::jsonb)) IS NOT TRUE
   OR contact.user_id IS NOT NULL AND contact.user_id IS DISTINCT FROM deal.user_id OR contact.assistant_id IS NOT NULL AND contact.assistant_id IS DISTINCT FROM deal.assistant_id THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  floor:=jsonb_build_object('sensitivity',contact.sensitivity,'compartments',contact.compartments,'projectIds',contact.project_ids);
 END IF;
 IF operation='primary' OR application_mutate_canonical_deal_participant.is_primary THEN
  PERFORM application_patch_canonical_crm('deal',deal_id,jsonb_build_object('contactId',contact_id),expected_version,floor);
  UPDATE crm_deal_contacts c SET is_primary=false WHERE c.workspace_id=w AND c.deal_id=application_mutate_canonical_deal_participant.deal_id AND c.is_primary;
 ELSIF operation='remove' AND deal.attributes->>'contact_id'=contact_id::text THEN
  -- Clear the scalar primary contact before its participant row. Both sides
  -- share this initial before-image and one canonical source version.
  PERFORM application_patch_canonical_crm('deal',deal_id,jsonb_build_object('contactId',NULL),expected_version,floor);
 ELSE
  PERFORM application_patch_canonical_crm('deal',deal_id,'{}',expected_version,floor);
 END IF;
 IF operation='remove' THEN
  DELETE FROM crm_deal_contacts c WHERE c.workspace_id=w AND c.deal_id=application_mutate_canonical_deal_participant.deal_id AND c.contact_id=application_mutate_canonical_deal_participant.contact_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 ELSIF contact_id IS NOT NULL THEN
  INSERT INTO crm_deal_contacts(workspace_id,deal_id,contact_id,role,is_primary,created_by)
  VALUES(w,deal_id,contact_id,participant_role,operation='primary' OR application_mutate_canonical_deal_participant.is_primary,nullif(current_setting('app.current_user_id',true),'')::uuid)
  ON CONFLICT ON CONSTRAINT crm_deal_contacts_pkey DO UPDATE SET role=EXCLUDED.role,is_primary=CASE WHEN operation='primary' OR application_mutate_canonical_deal_participant.is_primary THEN true ELSE crm_deal_contacts.is_primary END;
 END IF;
 state:=application_crm_patch_state('deal',deal_id,fields);
 IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('workspaceId',w,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','deal','id',deal_id,'version',state->'version');
END $$;
REVOKE ALL ON FUNCTION application_mutate_canonical_deal_participant(uuid,uuid,uuid,text,text,boolean,text) FROM PUBLIC;

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION application_crm_patch_state(text,uuid,text[]),application_patch_canonical_crm(text,uuid,jsonb,text,jsonb),application_create_canonical_crm_ref(text,jsonb,jsonb),application_task_patch_state(uuid,uuid,text[]),application_patch_canonical_task(uuid,uuid,jsonb,text,jsonb),application_native_task_identity(uuid,uuid),application_native_creation_ref(text,uuid,text[]),read_native_application_record(uuid,text,uuid,text[]),application_mutate_canonical_deal_participant(uuid,uuid,uuid,text,text,boolean,text) TO app_user;
END IF;END $$;
COMMIT;
