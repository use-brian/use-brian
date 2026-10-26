BEGIN;
-- [COMP:api/application-records] Fixed structural constraints, not an alternate ACL.
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.read_native_application_record(uuid,text,uuid,text[])'::regprocedure) INTO definition;
 before:='IF cardinality(application_native_field_keys(p_type))=0 THEN RETURN NULL;END IF;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native canonical read port changed';END IF;
 EXECUTE replace(definition,before,$source$IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.entities'::regclass
  WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 IF cardinality(application_native_field_keys(p_type))=0 THEN RETURN NULL;END IF;$source$);
END $migration$;

CREATE FUNCTION application_guard_native_reference_invariants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 app_context jsonb; native_policy jsonb; privileged boolean; old_values jsonb:='{}';new_values jsonb;intent jsonb;typed_fields text[];full_frame boolean:=true;
 scope_changed boolean:=true; reference record;target_id uuid;target_kind text;target_scope jsonb;target record;definition record;
 references_json jsonb:='[]';value jsonb;stage_pipeline uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.kind IN('company','person','deal') OR NEW.kind IN('company','person','deal'))
  AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
   OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_by_assistant_id IS DISTINCT FROM OLD.created_by_assistant_id
   OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
  RAISE EXCEPTION 'access_unavailable: immutable canonical native identity' USING ERRCODE='42501';END IF;
 IF NEW.kind NOT IN('company','person','deal') THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' OR NEW.aliases IS DISTINCT FROM OLD.aliases THEN
  IF array_position(NEW.aliases,NULL) IS NOT NULL OR EXISTS(SELECT 1 FROM unnest(NEW.aliases) alias
   WHERE length(alias) NOT BETWEEN 1 AND 200 OR alias IS DISTINCT FROM lower(btrim(alias)))
   OR cardinality(NEW.aliases)<>(SELECT count(DISTINCT alias) FROM unnest(NEW.aliases) alias) THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical native aliases' USING ERRCODE='22023';END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  old_values:=application_native_entity_attribute_values(OLD.attributes);
  scope_changed:=NEW.sensitivity IS DISTINCT FROM OLD.sensitivity OR NEW.compartments IS DISTINCT FROM OLD.compartments
   OR NEW.project_ids IS DISTINCT FROM OLD.project_ids OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.assistant_id IS DISTINCT FROM OLD.assistant_id;
  intent:=nullif(current_setting('app.native_entity_write_intent',true),'')::jsonb;
  IF intent->>'workspaceId'=NEW.workspace_id::text AND intent->>'typeKey'=NEW.kind AND intent->>'id'=NEW.id::text
   AND intent-ARRAY['workspaceId','typeKey','id','fields']='{}'::jsonb AND jsonb_typeof(intent->'fields')='array'
   AND jsonb_array_length(intent->'fields')<=128 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'fields') field WHERE jsonb_typeof(field)<>'string') THEN
   typed_fields:=ARRAY(SELECT jsonb_array_elements_text(intent->'fields'));full_frame:=false;
  ELSIF NEW.attributes IS NOT DISTINCT FROM OLD.attributes AND TG_ARGV[0]<>'attributes' THEN full_frame:=false;
  END IF;
 END IF;
 new_values:=application_native_entity_attribute_values(NEW.attributes);
 FOR reference IN SELECT * FROM (VALUES('companyId','company'),('contactId','person'),('ownerId','workspace_member'),
  ('pipelineId','crm_pipeline'),('pipelineStageId','crm_pipeline_stage')) fields(field,type_key) LOOP
  value:=new_values->reference.field;
  IF value IS NULL OR value='null'::jsonb THEN CONTINUE;END IF;
  IF scope_changed OR full_frame OR reference.field=ANY(typed_fields) OR value IS DISTINCT FROM old_values->reference.field THEN
   references_json:=references_json||jsonb_build_array(jsonb_build_object('field',reference.field,'typeKey',reference.type_key,'id',value));
  END IF;
 END LOOP;
 FOR definition IN SELECT * FROM public.crm_field_definitions WHERE workspace_id=NEW.workspace_id AND entity_kind=NEW.kind
  AND (archived_at IS NULL OR scope_changed) AND field_type='entity_reference' ORDER BY id FOR SHARE LOOP
  value:=new_values->('custom.'||definition.field_key);
  IF value IS NULL OR value='null'::jsonb THEN CONTINUE;END IF;
  IF application_native_custom_value_valid('entity_reference',definition.options,definition.is_required,value) IS NOT TRUE THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical custom reference' USING ERRCODE='22023';END IF;
  IF scope_changed OR full_frame OR 'custom.'||definition.field_key=ANY(typed_fields) OR value IS DISTINCT FROM old_values->('custom.'||definition.field_key) THEN
   references_json:=references_json||jsonb_build_array(jsonb_build_object('field','custom.'||definition.field_key,'allowedKinds',definition.options,'id',value));
  END IF;
 END LOOP;
 IF jsonb_array_length(references_json)=0 THEN RETURN NEW;END IF;
 SELECT coalesce(bool_or(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')),false) INTO privileged
  FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.entities'::regclass WHERE r.rolname=session_user;
 app_context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL AND (app_context IS NULL OR app_context->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text)
  OR actor IS NULL AND NOT privileged THEN RAISE EXCEPTION 'access_unavailable: canonical relationship unavailable' USING ERRCODE='42501';END IF;
 FOR reference IN SELECT entry->>'field' AS field,entry->>'typeKey' AS type_key,entry->'allowedKinds' AS allowed_kinds,entry->'id' AS id FROM jsonb_array_elements(references_json) entry LOOP
  IF jsonb_typeof(reference.id) IS DISTINCT FROM 'string' OR (reference.id#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical relationship ID' USING ERRCODE='22023';END IF;
  target_id:=(reference.id#>>'{}')::uuid;
  target_kind:=reference.type_key;target_scope:=NULL;
  IF target_kind='workspace_member' THEN
   PERFORM user_id FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=target_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable: canonical relationship unavailable' USING ERRCODE='42501';END IF;
   target_scope:=read_scope_source(NEW.workspace_id,'workspace_member',target_id);
  ELSIF target_kind IN('crm_pipeline','crm_pipeline_stage') THEN
   IF target_kind='crm_pipeline' THEN
    PERFORM id FROM public.crm_pipelines WHERE workspace_id=NEW.workspace_id AND id=target_id AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable: canonical relationship unavailable' USING ERRCODE='42501';END IF;
   ELSE
    SELECT stage.pipeline_id INTO stage_pipeline FROM public.crm_pipeline_stages stage WHERE stage.workspace_id=NEW.workspace_id AND stage.id=target_id AND stage.archived_at IS NULL FOR SHARE;
    IF NOT FOUND OR NEW.attributes->>'pipeline_id' IS DISTINCT FROM stage_pipeline::text THEN
     RAISE EXCEPTION 'access_unavailable: canonical relationship unavailable' USING ERRCODE='42501';END IF;
   END IF;
   IF actor IS NOT NULL AND (app_context IS NOT NULL OR application_native_query_bounds(NEW.workspace_id) IS NULL) THEN
    RAISE EXCEPTION 'access_unavailable: canonical configuration target unavailable' USING ERRCODE='42501';END IF;
   CONTINUE;
  ELSE
   SELECT e.kind,e.valid_to,e.retracted_at,e.scope_held,e.attributes->>'crm_archived_at' AS archived,e.attributes->'self' AS self
    INTO target FROM public.entities e WHERE e.workspace_id=NEW.workspace_id AND e.id=target_id FOR SHARE;
   IF NOT FOUND OR target.kind NOT IN('company','person','deal') OR target_kind IS NOT NULL AND target.kind<>target_kind
    OR reference.allowed_kinds IS NOT NULL AND NOT reference.allowed_kinds ? target.kind
    OR target.valid_to IS NOT NULL OR target.retracted_at IS NOT NULL OR target.scope_held OR target.archived IS NOT NULL
    OR target.kind='person' AND target.self='true'::jsonb THEN
    RAISE EXCEPTION 'access_unavailable: canonical relationship unavailable' USING ERRCODE='42501';END IF;
   target_kind:=target.kind;target_scope:=read_scope_source(NEW.workspace_id,'entity',target_id);
   IF target_scope IS NULL OR target_scope->>'held' IS DISTINCT FROM 'false' OR scope_review_state_held('entity',target_id)
    OR sensitivity_rank(NEW.sensitivity)<sensitivity_rank(target_scope->>'sensitivity')
    OR NOT coalesce(NEW.compartments,'{}') @> ARRAY(SELECT jsonb_array_elements_text(target_scope->'compartments'))
    OR NOT coalesce(NEW.project_ids,'{}') @> ARRAY(SELECT jsonb_array_elements_text(target_scope->'projectIds')::uuid)
    OR target_scope->>'userId' IS NOT NULL AND NEW.user_id::text IS DISTINCT FROM target_scope->>'userId'
    OR target_scope->>'assistantId' IS NOT NULL AND NEW.assistant_id::text IS DISTINCT FROM target_scope->>'assistantId' THEN
    RAISE EXCEPTION 'access_unavailable: canonical relationship scope unavailable' USING ERRCODE='42501';END IF;
  END IF;
  IF actor IS NOT NULL THEN
   IF app_context IS NOT NULL THEN
    IF application_field_reference_admitted(NEW.workspace_id,jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),
     'typeKey',target_kind,'id',target_id,'fields','[]'::jsonb)) IS NOT TRUE THEN
     RAISE EXCEPTION 'access_unavailable: canonical relationship unavailable' USING ERRCODE='42501';END IF;
   ELSE
    -- Native identity writes retain native row bounds. This does not release a
    -- derived payload or replace its additional Project/ancestry obligations.
    native_policy:=application_current_native_field_policy(NEW.workspace_id,'{"kind":"native","moduleKey":"native"}',target_kind,target_id);
    IF target_scope IS NULL OR target_scope->>'held' IS DISTINCT FROM 'false'
     OR workflow_evidence_envelope_visible(NEW.workspace_id,target_scope) IS NOT TRUE
     OR scope_review_state_held(CASE WHEN target_kind='workspace_member' THEN 'workspace_member' ELSE 'entity' END,target_id)
     OR native_policy->>'registered' IS DISTINCT FROM 'false' AND (native_policy->>'registered' IS DISTINCT FROM 'true' OR native_policy->>'held' IS DISTINCT FROM 'false') THEN
     RAISE EXCEPTION 'access_unavailable: canonical relationship unavailable' USING ERRCODE='42501';END IF;
   END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_reference_invariants() FROM PUBLIC;
CREATE TRIGGER application_native_entity_reference_invariants BEFORE INSERT OR UPDATE ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_reference_invariants('changed');
CREATE TRIGGER application_native_entity_reference_frame BEFORE UPDATE OF attributes ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_reference_invariants('attributes');
COMMIT;
