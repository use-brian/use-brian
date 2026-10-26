BEGIN;
-- [COMP:api/application-records] [COMP:security/native-field-policy]
-- Current native field authority on replay, and no typed hidden-value no-op oracle.
CREATE OR REPLACE FUNCTION application_generic_receipt_allows(type_id uuid,type_key text,record_id uuid,action text,required_fields text[] DEFAULT '{}') RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; record_row record; decision jsonb; command_decision jsonb; native_policy jsonb;
BEGIN
  IF action NOT IN('create','patch','delete') OR required_fields IS NULL OR cardinality(required_fields)>128
    OR array_position(required_fields,NULL) IS NOT NULL THEN RETURN false; END IF;
  SELECT workspace_id,created_by,sensitivity,compartments,project_ids INTO record_row FROM entity_instances WHERE id=record_id AND entity_type_id=type_id;
  IF NOT FOUND AND action='delete' THEN
    SELECT workspace_id,created_by,sensitivity,compartments,project_ids INTO record_row FROM application_record_tombstones WHERE id=record_id AND entity_type_id=type_id;
  END IF;
  IF NOT FOUND THEN RETURN false; END IF;
  context:=application_current_maxima();
  IF context IS NULL THEN
    IF NOT coalesce(nullif(current_setting('app.application_id',true),'') IS NULL
      AND context_scope_allows_current_principal(record_row.workspace_id,record_row.sensitivity,record_row.compartments,record_row.project_ids)
      AND member_operation_scope_allows(record_row.workspace_id,record_row.sensitivity,record_row.compartments,true)
      AND agent_mutation_scope_allows(record_row.compartments)
      AND NOT scope_review_state_held('entity_instance',record_id),false) THEN RETURN false; END IF;
    native_policy:=public.application_current_native_field_policy(record_row.workspace_id,
      jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id);
    IF native_policy->>'registered'='false' THEN RETURN true; END IF;
    RETURN coalesce(native_policy->>'registered'='true' AND native_policy->>'held'='false'
      AND to_jsonb(required_fields)<@(native_policy->'writeFields'),false);
  END IF;
  decision:=application_resource_fields(record_row.workspace_id,jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id::text,
    record_row.created_by,record_row.sensitivity,record_row.compartments,record_row.project_ids,NULL,action);
  command_decision:=application_resource_fields(record_row.workspace_id,jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id::text,
    record_row.created_by,record_row.sensitivity,record_row.compartments,record_row.project_ids,NULL,'command:'||current_setting('app.application_command_key',true));
  RETURN decision IS NOT NULL AND command_decision IS NOT NULL
    AND to_jsonb(required_fields)<@(decision->'write') AND to_jsonb(required_fields)<@(command_decision->'write');
END;
$$;
REVOKE ALL ON FUNCTION application_generic_receipt_allows(uuid,text,uuid,text,text[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_guard_generic_field_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical public.entity_instances; changed text[]; resource_origin jsonb; canonical_type text;
 decision jsonb; command_decision jsonb; write_fields jsonb; action text; alias text; command_key text; intent jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  canonical:=OLD;
  -- FK cascades are governed by the canonical parent operation; a vanished
  -- parent is not an independently editable source and exposes no payload.
  IF NOT EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=OLD.workspace_id)
   OR NOT EXISTS(SELECT 1 FROM public.entity_types t WHERE t.id=OLD.entity_type_id AND t.workspace_id=OLD.workspace_id) THEN RETURN OLD; END IF;
  changed:=ARRAY(SELECT jsonb_object_keys(OLD.data));action:='delete';
 ELSE
  canonical:=NEW;
  IF TG_OP='INSERT' THEN changed:=ARRAY(SELECT jsonb_object_keys(NEW.data));action:='create';
  ELSE
   canonical:=OLD;action:='patch';
   SELECT ARRAY(SELECT key FROM (SELECT jsonb_object_keys(OLD.data) AS key UNION SELECT jsonb_object_keys(NEW.data)) keys
    WHERE OLD.data->key IS DISTINCT FROM NEW.data->key ORDER BY key) INTO changed;
  END IF;
 END IF;
 -- Typed writers supply restriction-only intent, including equal assignments.
 -- Always union actual changes: an omitted/forged hint cannot authorize a field.
 IF TG_OP='UPDATE' THEN
  intent:=nullif(current_setting('app.application_native_write_intent',true),'')::jsonb;
  IF intent->>'id'=canonical.id::text THEN
   IF jsonb_typeof(intent) IS DISTINCT FROM 'object' OR intent-ARRAY['id','fields']<>'{}'::jsonb
    OR jsonb_typeof(intent->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(intent->'fields')>128
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'fields') item WHERE jsonb_typeof(item)<>'string') THEN
    RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
   changed:=ARRAY(SELECT unnest(changed) UNION SELECT jsonb_array_elements_text(intent->'fields'));
  END IF;
 END IF;
 resource_origin:=jsonb_build_object('kind','generic','entityTypeId',canonical.entity_type_id);canonical_type:='record.'||canonical.entity_type_id;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  alias:=nullif(current_setting('app.application_record_write_type',true),'');
  command_key:=nullif(current_setting('app.application_command_key',true),'');
  IF TG_OP='DELETE' THEN changed:='{}'; END IF;
  IF alias IS NULL OR command_key IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  decision:=public.application_resource_fields(canonical.workspace_id,resource_origin,alias,canonical.id::text,canonical.created_by,
   canonical.sensitivity,canonical.compartments,canonical.project_ids,NULL,action,CASE WHEN TG_OP='INSERT' THEN NEW.data ELSE NULL END);
  command_decision:=public.application_resource_fields(canonical.workspace_id,resource_origin,alias,canonical.id::text,canonical.created_by,
   canonical.sensitivity,canonical.compartments,canonical.project_ids,NULL,'command:'||command_key,CASE WHEN TG_OP='INSERT' THEN NEW.data ELSE NULL END);
  IF decision IS NULL OR command_decision IS NULL OR NOT coalesce(to_jsonb(changed)<@(decision->'write')
    AND to_jsonb(changed)<@(command_decision->'write'),false) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 ELSE
  -- Scope-only edits retain existing row/scope governance, with no cell change.
  IF cardinality(changed)=0 THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners r WHERE r.workspace_id=canonical.workspace_id
    AND r.origin=resource_origin AND r.resource_type=canonical_type) THEN
   IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
   decision:=public.read_native_application_field_catalog(canonical.workspace_id,resource_origin,canonical_type);
   write_fields:=decision->'writeFields';
  ELSE
   decision:=public.application_current_native_field_policy(canonical.workspace_id,resource_origin,canonical_type,canonical.id);
   IF decision->>'registered' IS DISTINCT FROM 'true' OR decision->>'held' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'access_unavailable: current native field policy unavailable' USING ERRCODE='42501'; END IF;
   write_fields:=decision->'writeFields';
  END IF;
  IF decision IS NULL OR NOT coalesce(to_jsonb(changed)<@write_fields,false) THEN RAISE EXCEPTION 'access_unavailable: native write field set unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION application_guard_generic_field_write() FROM PUBLIC;
COMMIT;
