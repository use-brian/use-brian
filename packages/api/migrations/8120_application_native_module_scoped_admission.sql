-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/application-management] Exact registered native owners and existing IDs only.
BEGIN;
DO $migration$ DECLARE definition text;original text;replacement text;BEGIN
 IF (SELECT provolatile FROM pg_proc WHERE oid='public.application_deployed_module_state(uuid,text)'::regprocedure)<>'s' THEN RAISE EXCEPTION 'native_module_prerequisite_changed: volatility';END IF;
 definition:=pg_get_functiondef('public.application_deployed_module_state(uuid,text)'::regprocedure);
 original:=$old0$ SELECT jsonb_agg(jsonb_build_object('owner',to_jsonb(o),'id',t.id,'schemaVersion',t.schema_version,'properties',t.properties) ORDER BY t.id)
 INTO schemas FROM application_native_resource_owners o JOIN entity_types t ON t.workspace_id=o.workspace_id AND o.origin=jsonb_build_object('kind','generic','entityTypeId',t.id)
 WHERE o.workspace_id=w AND o.module_key=module AND o.resource_type='record.'||t.id::text;
 IF schemas IS NULL OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w AND module_key=module AND origin->>'kind'<>'generic') THEN RETURN NULL;END IF;
$old0$;
 replacement:=$new0$ DECLARE ownership application_native_resource_owners;catalog jsonb;
 BEGIN
  SELECT jsonb_agg(jsonb_build_object('owner',to_jsonb(o),'id',t.id,'schemaVersion',t.schema_version,'properties',t.properties) ORDER BY t.id)
  INTO schemas FROM application_native_resource_owners o JOIN entity_types t ON t.workspace_id=o.workspace_id AND o.origin=jsonb_build_object('kind','generic','entityTypeId',t.id)
  WHERE o.workspace_id=w AND o.module_key=module AND o.resource_type='record.'||t.id::text;
  FOR ownership IN SELECT * FROM application_native_resource_owners WHERE workspace_id=w AND module_key=module ORDER BY origin::text,resource_type LOOP
   IF ownership.origin->>'kind'='generic' THEN
    IF NOT EXISTS(SELECT 1 FROM entity_types t WHERE t.workspace_id=w AND ownership.origin=jsonb_build_object('kind','generic','entityTypeId',t.id) AND ownership.resource_type='record.'||t.id::text) THEN RETURN NULL;END IF;
   ELSIF ownership.origin=jsonb_build_object('kind','native','moduleKey',module) THEN
    catalog:=application_native_field_catalog_for(w,ownership.origin,ownership.resource_type);
    IF catalog->>'registered' IS DISTINCT FROM 'true' OR catalog->>'held' IS DISTINCT FROM 'false'
     OR catalog#>>'{metadata,moduleKey}' IS DISTINCT FROM module OR catalog#>'{metadata,origin}' IS DISTINCT FROM ownership.origin
     OR catalog#>>'{metadata,typeKey}' IS DISTINCT FROM ownership.resource_type THEN RETURN NULL;END IF;
    schemas:=coalesce(schemas,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('owner',to_jsonb(ownership),'catalog',catalog));
   ELSE RETURN NULL;END IF;
  END LOOP;
  IF schemas IS NULL THEN RETURN NULL;END IF;
 END;
$new0$;
 IF (length(definition)-length(replace(definition,original,'')))/length(original)<>1 THEN RAISE EXCEPTION 'native_module_prerequisite_changed: application_deployed_module_state(uuid,text)';END IF;
 EXECUTE replace(definition,original,replacement);
 IF (SELECT provolatile FROM pg_proc WHERE oid='public.application_scoped_grant_allowed_before_frontend(uuid,jsonb)'::regprocedure)<>'s' THEN RAISE EXCEPTION 'native_module_prerequisite_changed: volatility';END IF;
 definition:=pg_get_functiondef('public.application_scoped_grant_allowed_before_frontend(uuid,jsonb)'::regprocedure);
 original:=$old1$ IF p->'origin'->>'kind'='native' AND app.module_key<>'native' THEN RETURN application_scoped_reference_grant_allowed(a,p);END IF;$old1$;
 replacement:=$new1$ IF app.module_key NOT IN('native','records') AND p->'origin'=jsonb_build_object('kind','native','moduleKey',app.module_key) THEN
  DECLARE catalog jsonb;permissions jsonb;
  BEGIN
   IF application_scoped_qualified(app.workspace_id,a) IS NOT TRUE OR p->'principal'->>'kind' IS DISTINCT FROM 'service'
    OR p->'selector'->>'kind' IS DISTINCT FROM 'ids' OR NOT EXISTS(SELECT 1 FROM application_native_resource_owners o
     WHERE o.workspace_id=app.workspace_id AND o.module_key=app.module_key AND o.origin=p->'origin' AND o.resource_type=p->>'typeKey') THEN RETURN false;END IF;
   SELECT * INTO capability FROM application_deployed_module_capabilities WHERE module_key=app.module_key;
   catalog:=application_native_field_catalog_for(app.workspace_id,p->'origin',p->>'typeKey');
   IF capability.module_key IS NULL OR catalog->>'registered' IS DISTINCT FROM 'true' OR catalog->>'held' IS DISTINCT FROM 'false'
    OR catalog#>>'{metadata,moduleKey}' IS DISTINCT FROM app.module_key THEN RETURN false;END IF;
   permissions:=application_native_nonmember_field_permissions(catalog,'service');
   RETURN permissions IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action
    WHERE action<>'read' AND NOT(action LIKE 'command:%' AND substring(action FROM 9)=ANY(capability.commands)))
    AND p->'readFields'<@(permissions->'read') AND p->'writeFields'<@(permissions->'write');
  END;
 END IF;
 IF p->'origin'->>'kind'='native' AND app.module_key<>'native' THEN RETURN application_scoped_reference_grant_allowed(a,p);END IF;$new1$;
 IF (length(definition)-length(replace(definition,original,'')))/length(original)<>1 THEN RAISE EXCEPTION 'native_module_prerequisite_changed: application_scoped_grant_allowed_before_frontend(uuid,jsonb)';END IF;
 EXECUTE replace(definition,original,replacement);
 IF (SELECT provolatile FROM pg_proc WHERE oid='public.application_grant_release_snapshot_before_source_service(uuid,jsonb)'::regprocedure)<>'s' THEN RAISE EXCEPTION 'native_module_prerequisite_changed: volatility';END IF;
 definition:=pg_get_functiondef('public.application_grant_release_snapshot_before_source_service(uuid,jsonb)'::regprocedure);
 original:=$old2$  ELSE RETURN NULL; END IF;
  IF NOT proposal->'readFields'<@to_jsonb(fields)$old2$;
 replacement:=$new2$  ELSIF app.module_key NOT IN('native','records') AND origin=jsonb_build_object('kind','native','moduleKey',app.module_key) THEN
    DECLARE catalog jsonb;policy jsonb;issuer_mask jsonb;service_mask jsonb;selected_id text;
    BEGIN
      IF proposal->'selector'->>'kind' IS DISTINCT FROM 'ids' OR application_scoped_grant_allowed(app.id,proposal) IS NOT TRUE
        OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(proposal->'selector'->'ids')) THEN RETURN NULL;END IF;
      catalog:=application_native_field_catalog_for(app.workspace_id,origin,proposal->>'typeKey');
      IF catalog->>'registered' IS DISTINCT FROM 'true' OR catalog->>'held' IS DISTINCT FROM 'false'
        OR catalog#>>'{metadata,moduleKey}' IS DISTINCT FROM app.module_key THEN RETURN NULL;END IF;
      scope:=catalog#>'{metadata,scope}';
      IF application_release_scope_allows(actor,app.workspace_id,scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),
        ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid),(scope->>'userId')::uuid) IS NOT TRUE
        OR scope->>'userId' IS NOT NULL AND scope->>'userId'<>subject::text THEN RETURN NULL;END IF;
      issuer_mask:=application_native_member_field_permissions(app.workspace_id,catalog,actor);
      service_mask:=application_native_nonmember_field_permissions(catalog,'service');
      IF issuer_mask IS NULL OR service_mask IS NULL THEN RETURN NULL;END IF;
      fields:=ARRAY(SELECT jsonb_array_elements_text(issuer_mask->'read') INTERSECT SELECT jsonb_array_elements_text(service_mask->'read'));
      writable:=ARRAY(SELECT jsonb_array_elements_text(issuer_mask->'write') INTERSECT SELECT jsonb_array_elements_text(service_mask->'write'));
      schema_metadata:=catalog;
      FOR selected_id IN SELECT jsonb_array_elements_text(proposal->'selector'->'ids') ORDER BY 1 LOOP
        policy:=application_native_field_contract_for(app.workspace_id,origin,proposal->>'typeKey',selected_id);
        IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
          OR policy#>>'{metadata,moduleKey}' IS DISTINCT FROM app.module_key OR policy#>'{metadata,origin}' IS DISTINCT FROM origin
          OR policy#>>'{metadata,typeKey}' IS DISTINCT FROM proposal->>'typeKey' THEN RETURN NULL;END IF;
        scope:=policy#>'{metadata,source}';
        IF application_release_scope_allows(actor,app.workspace_id,scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),
          ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid),(scope->>'userId')::uuid) IS NOT TRUE
          OR scope->>'userId' IS NOT NULL AND scope->>'userId'<>subject::text
          OR sensitivity_rank(scope->>'sensitivity')>sensitivity_rank(proposal->>'clearance')
          OR NOT (scope->'compartments')<@(proposal->'compartments') OR NOT (scope->'projectIds')<@(proposal->'projectIds')
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(proposal->'actions') action WHERE action<>'read')
           AND member_operation_row_allows(member_principal_operation_grants(actor,true,app.workspace_id),app.workspace_id,scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(scope->'compartments'))) IS NOT TRUE THEN RETURN NULL;END IF;
        issuer_mask:=application_native_member_field_permissions(app.workspace_id,policy,actor);
        service_mask:=application_native_nonmember_field_permissions(policy,'service');
        IF issuer_mask IS NULL OR service_mask IS NULL OR NOT proposal->'readFields'<@(issuer_mask->'read') OR NOT proposal->'readFields'<@(service_mask->'read')
          OR NOT proposal->'writeFields'<@(issuer_mask->'write') OR NOT proposal->'writeFields'<@(service_mask->'write') THEN RETURN NULL;END IF;
        sources:=sources||jsonb_build_array(jsonb_build_object('id',selected_id,'version',policy#>>'{metadata,recordVersion}','policyFingerprint',policy->'fingerprint','scope',scope));
      END LOOP;
    END;
  ELSE RETURN NULL; END IF;
  IF NOT proposal->'readFields'<@to_jsonb(fields)$new2$;
 IF (length(definition)-length(replace(definition,original,'')))/length(original)<>1 THEN RAISE EXCEPTION 'native_module_prerequisite_changed: application_grant_release_snapshot_before_source_service(uuid,jsonb)';END IF;
 EXECUTE replace(definition,original,replacement);
END $migration$;
COMMIT;
