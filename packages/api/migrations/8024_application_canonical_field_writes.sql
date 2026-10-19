BEGIN;
-- [COMP:api/application-records] Canonical current field write sets for every generic writer.
CREATE OR REPLACE FUNCTION application_path_fields(maximum jsonb,subject jsonb,w uuid,origin jsonb,type_key text,record_id text,owner_id uuid,
 tier text,teams text[],projects uuid[],row_user uuid,action text,prospective_data jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE decision jsonb; policy jsonb; issued jsonb; current_grant public.application_access_grants; issuer_mask jsonb; principal_mask jsonb; member_mask jsonb; native_member boolean;
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
  decision:=jsonb_build_object('read',ARRAY(SELECT jsonb_array_elements_text(decision->'read')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'read') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'read')),
   'write',ARRAY(SELECT jsonb_array_elements_text(decision->'write')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'write') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'write')));
 END LOOP;
 RETURN decision;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_generic_write(type_id uuid,type_key text,operation text,record_id uuid,expected_version bigint,
  changes jsonb,tier text DEFAULT 'internal',teams text[] DEFAULT '{}',projects uuid[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; w uuid; actor uuid; current_row entity_instances; decision jsonb; command_decision jsonb;
  field text; property jsonb; cell jsonb; target_id uuid; next_version bigint; command_key text; previous_type text;
BEGIN
  context:=application_current_maxima(); command_key:=nullif(current_setting('app.application_command_key',true),'');
  IF context IS NULL OR context->>'readOnly'='true' OR operation NOT IN('create','patch','delete')
    OR command_key IS NULL OR command_key !~ '^[a-z][a-z0-9_.-]{0,127}$'
    OR record_id IS NULL OR jsonb_typeof(changes) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(changes))>128 THEN
    RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';
  END IF;
  w:=(context->>'workspaceId')::uuid;actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  PERFORM 1 FROM entity_types t WHERE t.id=type_id AND t.workspace_id=w FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  IF operation='create' THEN
    current_row.workspace_id:=w;current_row.entity_type_id:=type_id;current_row.id:=record_id;current_row.created_by:=actor;
    current_row.sensitivity:=tier;current_row.compartments:=teams;current_row.project_ids:=projects;
  ELSE
    SELECT * INTO current_row FROM entity_instances r WHERE r.id=record_id AND r.workspace_id=w AND r.entity_type_id=type_id FOR UPDATE;
    IF NOT FOUND OR scope_review_state_held('entity_instance',record_id) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  decision:=application_resource_fields(w,jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id::text,
    current_row.created_by,current_row.sensitivity,current_row.compartments,current_row.project_ids,NULL,operation,CASE WHEN operation='create' THEN changes ELSE NULL END);
  command_decision:=application_resource_fields(w,jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id::text,
    current_row.created_by,current_row.sensitivity,current_row.compartments,current_row.project_ids,NULL,'command:'||command_key,CASE WHEN operation='create' THEN changes ELSE NULL END);
  IF decision IS NULL OR command_decision IS NULL
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(changes) k WHERE NOT decision->'write' ? k OR NOT command_decision->'write' ? k) THEN
    RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';
  END IF;
  IF operation<>'create' AND (expected_version IS NULL OR expected_version<>current_row.record_version) THEN
    RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';
  END IF;
  FOR field,cell IN SELECT key,value FROM jsonb_each(changes) LOOP
    SELECT p INTO property FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p WHERE t.id=type_id AND p->>'name'=field;
    IF property IS NULL THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END IF;
    IF cell->'value' IS NULL OR cell->'value'='null'::jsonb THEN CONTINUE; END IF;
    IF property->'config'->>'kind'='relation' THEN
      BEGIN target_id:=(cell->>'value')::uuid;
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END;
      IF NOT application_generic_reference_allows(w,property->'config'->'targetEntityTypeRef'->>'kind',
        coalesce(property->'config'->'targetEntityTypeRef'->>'entityTypeId',property->'config'->'targetEntityTypeRef'->>'name'),target_id) THEN
        RAISE EXCEPTION 'invalid_value: reference unavailable' USING ERRCODE='22023';
      END IF;
    ELSIF property->'config'->>'kind' IN('person','files') AND NOT application_relation_cell_allows(w,property,cell) THEN
      RAISE EXCEPTION 'access_unavailable: reference unavailable' USING ERRCODE='42501';
    END IF;
  END LOOP;
  -- Only this fixed writer carries an admitted alias into the row trigger.
  -- Named command/row/field checks above remain mandatory for every operation.
  previous_type:=current_setting('app.application_record_write_type',true);
  PERFORM set_config('app.application_record_write_type',type_key,true);
  IF operation='create' THEN
    INSERT INTO entity_instances(id,workspace_id,entity_type_id,data,source_app,created_by,last_edited_by,sensitivity,compartments,project_ids)
      VALUES(record_id,w,type_id,changes,'api',actor,actor,tier,teams,projects) RETURNING record_version INTO next_version;
  ELSIF operation='patch' THEN
    UPDATE entity_instances SET data=data||changes,last_edited_by=actor,last_edited_at=now()
      WHERE id=record_id RETURNING record_version INTO next_version;
  ELSE
    IF changes<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END IF;
    next_version:=current_row.record_version+1;
    DELETE FROM entity_instances WHERE id=record_id;
  END IF;
  PERFORM set_config('app.application_record_write_type',coalesce(previous_type,''),true);
  RETURN jsonb_build_object('workspaceId',w,'origin',jsonb_build_object('kind','generic','entityTypeId',type_id),
    'typeKey',type_key,'id',record_id,'version',next_version::text);
END;
$$;
REVOKE ALL ON FUNCTION application_generic_write(uuid,text,text,uuid,bigint,jsonb,text,text[],uuid[]) FROM PUBLIC;


-- One canonical cell boundary, including old SQL writers. This is a restriction,
-- never a replacement for existing row RLS, schema/value/reference or CAS checks.
CREATE FUNCTION application_guard_generic_field_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical public.entity_instances; changed text[]; resource_origin jsonb; canonical_type text;
 decision jsonb; command_decision jsonb; write_fields jsonb; action text; alias text; command_key text;
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
CREATE TRIGGER application_record_field_authority BEFORE INSERT OR UPDATE OR DELETE ON public.entity_instances
FOR EACH ROW EXECUTE FUNCTION public.application_guard_generic_field_write();

-- App/native file observations share canonical owner metadata. This private
-- metadata lookup changes no payload admission and no source identity.
DO $migration$ DECLARE definition text; original text; replacement text; BEGIN
 SELECT pg_get_functiondef('public.application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure) INTO definition;
 original:=$before$IF p_type='task' THEN SELECT to_jsonb(t) INTO native_row FROM tasks t WHERE t.workspace_id=w AND t.id=p_id;$before$;
 replacement:=$after$IF p_type='file' THEN SELECT jsonb_build_object('created_by_user_id',f.created_by_user_id) INTO native_row FROM public.workspace_files f WHERE f.workspace_id=w AND f.id=p_id;
   ELSIF p_type='task' THEN SELECT to_jsonb(t) INTO native_row FROM tasks t WHERE t.workspace_id=w AND t.id=p_id;$after$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'Canonical field owner branch changed'; END IF;
 EXECUTE replace(definition,original,replacement);
END $migration$;

COMMIT;
