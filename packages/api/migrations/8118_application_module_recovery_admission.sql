-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/application-auth] Lifecycle admission is separate from exact deployed identity.
BEGIN;
DO $upgrade$
DECLARE definition text; original text; replacement text;
BEGIN
 definition:=pg_get_functiondef('public.application_deployed_module_state(uuid,text)'::regprocedure);
 original:=$old0$IF coalesce(lifecycle->>'state',capability.default_state)<>'enabled' THEN RETURN NULL;END IF;$old0$;
 replacement:=$new0$$new0$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: application_deployed_module_state(uuid,text)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_scoped_qualified_before_frontend(uuid,uuid)'::regprocedure);
 original:=$old1$s.deployed_snapshot IS NOT NULL AND s.deployed_snapshot=application_deployed_module_state(w,c.module_key)$old1$;
 replacement:=$new1$s.deployed_snapshot IS NOT NULL AND (s.deployed_snapshot-'moduleLifecycle')=(application_deployed_module_state(w,c.module_key)-'moduleLifecycle')$new1$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: application_scoped_qualified_before_frontend(uuid,uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_scoped_qualified(uuid,uuid)'::regprocedure);
 original:=$old2$s.profile IN('canonical_records_frontend_v1','canonical_app_delegation_v1') AND c.module_key='records' OR s.profile IN('canonical_module_frontend_v1','canonical_app_delegation_v1') AND c.module_key NOT IN('native','records') AND s.deployed_snapshot=application_deployed_module_state(w,c.module_key)$old2$;
 replacement:=$new2$s.profile IN('canonical_records_frontend_v1','canonical_app_delegation_v1') AND c.module_key='records' OR s.profile IN('canonical_module_frontend_v1','canonical_app_delegation_v1') AND c.module_key NOT IN('native','records') AND (s.deployed_snapshot-'moduleLifecycle')=(application_deployed_module_state(w,c.module_key)-'moduleLifecycle')$new2$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: application_scoped_qualified(uuid,uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_activation_snapshot_before_frontend(uuid)'::regprocedure);
 original:=$old3$IF agent.id IS NULL OR deployed IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;$old3$;
 replacement:=$new3$IF agent.id IS NULL OR deployed IS NULL OR deployed#>>'{moduleLifecycle,state}' IS DISTINCT FROM 'enabled' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;$new3$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: application_activation_snapshot_before_frontend(uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_activation_snapshot(uuid)'::regprocedure);
 original:=$old4$IF deployed IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;$old4$;
 replacement:=$new4$IF deployed IS NULL OR deployed#>>'{moduleLifecycle,state}' IS DISTINCT FROM 'enabled' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;$new4$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: application_activation_snapshot(uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_scoped_grant_allowed(uuid,jsonb)'::regprocedure);
 original:=$old5$SELECT * INTO app FROM application_clients WHERE id=a;
 IF app.client_mode IS DISTINCT FROM$old5$;
 replacement:=$new5$SELECT * INTO app FROM application_clients WHERE id=a;
 IF app.module_key NOT IN('native','records') AND (application_deployed_module_state(app.workspace_id,app.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled' THEN RETURN false;END IF;
 IF app.client_mode IS DISTINCT FROM$new5$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: application_scoped_grant_allowed(uuid,jsonb)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_native_governance_proposal_allows(uuid,text,jsonb)'::regprocedure);
 original:=$old6$AND u.auth_provider_id LIKE 'app-service:'||c.id::text||':%' AND c.workspace_id=w AND c.module_key=module AND c.status='active'
   WHERE u.id=(proposal->>'userId')::uuid AND public.application_scoped_qualified(w,c.id)$old6$;
 replacement:=$new6$AND u.auth_provider_id LIKE 'app-service:'||c.id::text||':%' AND c.workspace_id=w AND c.module_key=module AND c.status='active'
   AND (c.module_key IN('native','records') OR (public.application_deployed_module_state(w,c.module_key)#>>'{moduleLifecycle,state}')='enabled')
   WHERE u.id=(proposal->>'userId')::uuid AND public.application_scoped_qualified(w,c.id)$new6$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: application_native_governance_proposal_allows(uuid,text,jsonb)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_scoped_oauth_binding_version()'::regprocedure);
 original:=$old7$IF EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=NEW.app_id) THEN
 IF NOT EXISTS$old7$;
 replacement:=$new7$IF EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=NEW.app_id) THEN
 IF EXISTS(SELECT 1 FROM application_clients c WHERE c.id=NEW.app_id AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(c.workspace_id,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS$new7$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: application_scoped_oauth_binding_version()';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.prepare_source_service_binding(uuid,uuid,uuid,uuid,uuid,timestamptz)'::regprocedure);
 original:=$old8$IF service IS NULL THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;$old8$;
 replacement:=$new8$IF service IS NULL OR EXISTS(SELECT 1 FROM application_clients c WHERE c.id=app AND c.workspace_id=w AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(w,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled') THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;$new8$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: prepare_source_service_binding(uuid,uuid,uuid,uuid,uuid,timestamptz)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.activate_source_service_binding(uuid,uuid)'::regprocedure);
 original:=$old9$IF b.id IS NULL OR b.status<>'pending' OR b.expires_at<=clock_timestamp()$old9$;
 replacement:=$new9$IF b.id IS NULL OR EXISTS(SELECT 1 FROM application_clients c WHERE c.id=b.app_id AND c.workspace_id=b.workspace_id AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(c.workspace_id,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled') OR b.status<>'pending' OR b.expires_at<=clock_timestamp()$new9$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
  RAISE EXCEPTION 'module_recovery_prerequisite_changed: activate_source_service_binding(uuid,uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
END $upgrade$;
COMMIT;
