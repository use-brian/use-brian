BEGIN;
-- [COMP:api/application-records] [COMP:security/native-field-policy]
CREATE OR REPLACE FUNCTION application_native_schema_governance_allows(w uuid,type_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE resource_origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',type_id); type_key text:='record.'||type_id;
 fields jsonb; catalog jsonb; policy jsonb; source record;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w
    AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) THEN RETURN false; END IF;
 SELECT coalesce(jsonb_agg(p->'name'),'[]'::jsonb) INTO fields FROM public.entity_types t,
  LATERAL jsonb_array_elements(t.properties) p WHERE t.workspace_id=w AND t.id=type_id;
 IF NOT EXISTS(SELECT 1 FROM public.entity_types t WHERE t.workspace_id=w AND t.id=type_id) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o
  WHERE o.workspace_id=w AND o.origin=resource_origin AND o.resource_type=type_key) THEN RETURN true; END IF;
 IF public.application_governance_allows(w) IS NOT TRUE THEN RETURN false; END IF;
 catalog:=public.read_native_application_field_catalog(w,resource_origin,type_key);
 IF catalog IS NULL OR NOT coalesce(fields<@(catalog->'readFields') AND fields<@(catalog->'writeFields'),false) THEN RETURN false; END IF;
 FOR source IN SELECT r.id,r.sensitivity,r.compartments,r.project_ids FROM public.entity_instances r
  WHERE r.workspace_id=w AND r.entity_type_id=type_id ORDER BY r.id FOR SHARE LOOP
  IF public.scope_review_state_held('entity_instance',source.id)
   OR public.context_scope_allows_current_principal(w,source.sensitivity,source.compartments,source.project_ids) IS NOT TRUE
   OR public.member_operation_scope_allows(w,source.sensitivity,source.compartments,true) IS NOT TRUE
   OR public.agent_mutation_scope_allows(source.compartments) IS NOT TRUE THEN RETURN false; END IF;
  policy:=public.application_current_native_field_policy(w,resource_origin,type_key,source.id);
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR NOT coalesce(fields<@(policy->'readFields') AND fields<@(policy->'writeFields'),false) THEN RETURN false; END IF;
  -- Use the same admitted current-principal field/reference port as actual
  -- canonical readers. Its values never leave this metadata-only preflight.
  IF public.application_field_projection_state(w,resource_origin,type_key,source.id,'read',NULL,
    ARRAY(SELECT jsonb_array_elements_text(fields))) IS NULL THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_schema_governance_allows(uuid,uuid) FROM PUBLIC;

COMMIT;
