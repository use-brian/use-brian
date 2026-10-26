BEGIN;
-- [COMP:api/application-records] Current protected deletion authority without payload snapshots.
ALTER TABLE public.application_record_tombstones ADD COLUMN deleted_fields text[]
 CHECK(deleted_fields IS NULL OR cardinality(deleted_fields)<=128 AND array_position(deleted_fields,NULL) IS NULL);

CREATE OR REPLACE FUNCTION application_generic_tombstone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.entity_types t WHERE t.id=OLD.entity_type_id)
  AND EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=OLD.workspace_id) THEN
  INSERT INTO public.application_record_tombstones(workspace_id,entity_type_id,id,record_version,created_by,sensitivity,compartments,project_ids,deleted_fields)
   VALUES(OLD.workspace_id,OLD.entity_type_id,OLD.id,OLD.record_version+1,OLD.created_by,OLD.sensitivity,OLD.compartments,OLD.project_ids,
    ARRAY(SELECT key FROM jsonb_object_keys(OLD.data) key ORDER BY key));
 END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION application_generic_tombstone() FROM PUBLIC;

-- Private to deployed native metadata readers, never a source-data read grant.
CREATE FUNCTION read_application_generic_tombstone_source(w uuid,type_id uuid,record_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tombstone public.application_record_tombstones;
BEGIN
 SELECT * INTO tombstone FROM public.application_record_tombstones t WHERE t.workspace_id=w AND t.entity_type_id=type_id AND t.id=record_id;
 IF NOT FOUND OR tombstone.deleted_fields IS NULL OR public.scope_review_state_held('entity_instance',record_id) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity',tombstone.sensitivity,
  'compartments',tombstone.compartments,'projectIds',tombstone.project_ids,'version',tombstone.record_version::text,
  'held',false,'retractedAt',NULL,'validTo',NULL);
END $$;
REVOKE ALL ON FUNCTION read_application_generic_tombstone_source(uuid,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_generic_receipt_allows(type_id uuid,type_key text,record_id uuid,action text,required_fields text[] DEFAULT '{}') RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; record_row record; decision jsonb; command_decision jsonb; native_policy jsonb;
BEGIN
  IF action NOT IN('create','patch','delete') OR required_fields IS NULL OR cardinality(required_fields)>128
    OR array_position(required_fields,NULL) IS NOT NULL THEN RETURN false; END IF;
  SELECT workspace_id,created_by,sensitivity,compartments,project_ids,NULL::text[] AS deleted_fields INTO record_row FROM entity_instances WHERE id=record_id AND entity_type_id=type_id;
  IF NOT FOUND AND action='delete' THEN
    SELECT workspace_id,created_by,sensitivity,compartments,project_ids,deleted_fields INTO record_row FROM application_record_tombstones WHERE id=record_id AND entity_type_id=type_id;
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
    IF action='delete' THEN
      IF record_row.deleted_fields IS NULL THEN RETURN false; END IF;
      required_fields:=record_row.deleted_fields;
    END IF;
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


CREATE OR REPLACE FUNCTION application_path_fields(maximum jsonb,subject jsonb,w uuid,origin jsonb,type_key text,record_id text,owner_id uuid,
 tier text,teams text[],projects uuid[],row_user uuid,action text,prospective_data jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE decision jsonb; policy jsonb; issued jsonb; current_grant public.application_access_grants; issuer_mask jsonb; principal_mask jsonb; member_mask jsonb; native_member boolean; deleted_keys text[];
BEGIN
 decision:=public.application_path_fields_before_module_policy(maximum,subject,w,origin,type_key,record_id,owner_id,tier,teams,projects,row_user,action,prospective_data);
 IF decision IS NULL THEN RETURN NULL; END IF;
 FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
  SELECT * INTO current_grant FROM public.application_access_grants g WHERE g.id=(issued->>'id')::uuid
   AND g.workspace_id=w AND g.app_id=(public.application_current_maxima()->>'appId')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF current_grant.principal_kind<>'member' AND EXISTS(SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id=w AND m.user_id=current_grant.principal_user_id) THEN
   IF public.application_release_scope_allows(current_grant.principal_user_id,w,tier,teams,projects,row_user) IS NOT TRUE
    OR action NOT IN('read','query','history','schema') AND public.member_operation_row_allows(
     public.member_principal_operation_grants(current_grant.principal_user_id,true,w),w,tier,teams) IS NOT TRUE THEN RETURN NULL; END IF;
  END IF;
 END LOOP;
 -- Before insertion, the deployed catalog is the policy. A synthetic row
 -- cannot stand in for a current canonical record/field observation.
 IF prospective_data IS NOT NULL AND (action='create' OR starts_with(action,'command:')) THEN
  policy:=public.application_native_field_catalog_for(w,origin,type_key);
 ELSE
  policy:=public.application_native_field_contract_for(w,origin,type_key,record_id);
 END IF;
 IF policy->>'registered'='false' THEN RETURN decision; END IF;
 IF policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
 IF action='delete' THEN
  IF origin->>'kind'='generic' THEN
   SELECT ARRAY(SELECT jsonb_object_keys(r.data)) INTO deleted_keys FROM public.entity_instances r WHERE r.workspace_id=w
    AND r.entity_type_id=(origin->>'entityTypeId')::uuid AND r.id=record_id::uuid;
   IF NOT FOUND THEN SELECT t.deleted_fields INTO deleted_keys FROM public.application_record_tombstones t WHERE t.workspace_id=w
    AND t.entity_type_id=(origin->>'entityTypeId')::uuid AND t.id=record_id::uuid; END IF;
  ELSE deleted_keys:=ARRAY(SELECT jsonb_array_elements_text(policy#>'{metadata,fieldKeys}'));
  END IF;
  IF deleted_keys IS NULL THEN RETURN NULL; END IF;
 END IF;
 FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
  SELECT * INTO current_grant FROM public.application_access_grants g WHERE g.id=(issued->>'id')::uuid
   AND g.workspace_id=w AND g.app_id=(public.application_current_maxima()->>'appId')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  issuer_mask:=public.application_native_member_field_permissions(w,policy,current_grant.issued_by_user_id);
  native_member:=EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=current_grant.principal_user_id);
  principal_mask:=CASE WHEN current_grant.principal_kind='member'
   THEN public.application_native_member_field_permissions(w,policy,current_grant.principal_user_id)
   ELSE public.application_native_nonmember_field_permissions(policy,current_grant.principal_kind) END;
  IF issuer_mask IS NULL OR principal_mask IS NULL THEN RETURN NULL; END IF;
  IF native_member AND current_grant.principal_kind<>'member' THEN
   member_mask:=public.application_native_member_field_permissions(w,policy,current_grant.principal_user_id);
   IF member_mask IS NULL THEN RETURN NULL; END IF;
   principal_mask:=jsonb_build_object('read',public.application_query_set_intersection(principal_mask->'read',member_mask->'read'),
    'write',public.application_query_set_intersection(principal_mask->'write',member_mask->'write'));
  END IF;
  -- A row-delete grant cannot replace a protected module's complete current
  -- issuer/member/release floor. Field subsets still govern individual patches.
  IF action='delete' AND NOT coalesce(to_jsonb(deleted_keys)<@(issuer_mask->'write')
   AND to_jsonb(deleted_keys)<@(principal_mask->'write'),false) THEN RETURN NULL; END IF;
  decision:=jsonb_build_object('read',ARRAY(SELECT jsonb_array_elements_text(decision->'read')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'read') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'read')),
   'write',ARRAY(SELECT jsonb_array_elements_text(decision->'write')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'write') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'write')));
 END LOOP;
 RETURN decision;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;


COMMIT;
