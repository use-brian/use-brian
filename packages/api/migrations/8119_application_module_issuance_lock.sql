-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/application-auth] Mutation-owned lifecycle locks precede fresh authority checks.
BEGIN;
DO $upgrade$
DECLARE definition text; original text; replacement text;
BEGIN
 definition:=pg_get_functiondef('public.application_apply_grant_review(uuid)'::regprocedure);
 original:=$old0$  IF review.consumed_grant_id IS NOT NULL THEN RETURN review.consumed_grant_id; END IF;
  proposal:=review.proposed_grant;snapshot:=application_grant_release_snapshot(review.app_id,proposal);$old0$;
 replacement:=$new0$  IF review.consumed_grant_id IS NOT NULL THEN RETURN review.consumed_grant_id; END IF;
 -- Fresh custom authority shares the lifecycle admission locks until COMMIT.
 DECLARE issuance_app public.application_clients;
 BEGIN
  SELECT c.* INTO issuance_app FROM public.application_clients c WHERE c.id=review.app_id AND c.workspace_id=review.workspace_id AND c.module_key NOT IN('native','records') FOR SHARE;
  IF issuance_app.id IS NOT NULL THEN
   PERFORM 1 FROM public.workspaces WHERE id=issuance_app.workspace_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM public.workspace_modules WHERE workspace_id=issuance_app.workspace_id AND module_key=issuance_app.module_key FOR SHARE;
  END IF;
 END;
  proposal:=review.proposed_grant;snapshot:=application_grant_release_snapshot(review.app_id,proposal);$new0$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.application_apply_grant_review(uuid)'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: application_apply_grant_review(uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_reviewed_grant_guard()'::regprocedure);
 original:=$old1$  SELECT * INTO review FROM application_grant_reviews WHERE id=nullif(current_setting('app.application_grant_review_id',true),'')::uuid FOR UPDATE;
  proposal:=jsonb_build_object$old1$;
 replacement:=$new1$  SELECT * INTO review FROM application_grant_reviews WHERE id=nullif(current_setting('app.application_grant_review_id',true),'')::uuid FOR UPDATE;
 -- Fresh custom authority shares the lifecycle admission locks until COMMIT.
 DECLARE issuance_app public.application_clients;
 BEGIN
  SELECT c.* INTO issuance_app FROM public.application_clients c WHERE c.id=NEW.app_id AND c.workspace_id=NEW.workspace_id AND c.module_key NOT IN('native','records') FOR SHARE;
  IF issuance_app.id IS NOT NULL THEN
   PERFORM 1 FROM public.workspaces WHERE id=issuance_app.workspace_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM public.workspace_modules WHERE workspace_id=issuance_app.workspace_id AND module_key=issuance_app.module_key FOR SHARE;
  END IF;
 END;
  proposal:=jsonb_build_object$new1$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.application_reviewed_grant_guard()'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: application_reviewed_grant_guard()';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_apply_credential_review(uuid,uuid,text)'::regprocedure);
 original:=$old2$  IF review.consumed_credential_id IS NOT NULL THEN RETURN jsonb_build_object('id',review.consumed_credential_id,'created',false); END IF;
  snapshot:=application_credential_release_snapshot(review.app_id,review.proposal);$old2$;
 replacement:=$new2$  IF review.consumed_credential_id IS NOT NULL THEN RETURN jsonb_build_object('id',review.consumed_credential_id,'created',false); END IF;
 -- Fresh custom authority shares the lifecycle admission locks until COMMIT.
 DECLARE issuance_app public.application_clients;
 BEGIN
  SELECT c.* INTO issuance_app FROM public.application_clients c WHERE c.id=review.app_id AND c.workspace_id=review.workspace_id AND c.module_key NOT IN('native','records') FOR SHARE;
  IF issuance_app.id IS NOT NULL THEN
   PERFORM 1 FROM public.workspaces WHERE id=issuance_app.workspace_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM public.workspace_modules WHERE workspace_id=issuance_app.workspace_id AND module_key=issuance_app.module_key FOR SHARE;
  END IF;
 END;
  snapshot:=application_credential_release_snapshot(review.app_id,review.proposal);$new2$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.application_apply_credential_review(uuid,uuid,text)'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: application_apply_credential_review(uuid,uuid,text)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_reviewed_credential_guard()'::regprocedure);
 original:=$old3$  SELECT * INTO review FROM application_credential_reviews WHERE id=nullif(current_setting('app.application_credential_review_id',true),'')::uuid FOR UPDATE;
  IF review.id IS NULL$old3$;
 replacement:=$new3$  SELECT * INTO review FROM application_credential_reviews WHERE id=nullif(current_setting('app.application_credential_review_id',true),'')::uuid FOR UPDATE;
 -- Fresh custom authority shares the lifecycle admission locks until COMMIT.
 DECLARE issuance_app public.application_clients;
 BEGIN
  SELECT c.* INTO issuance_app FROM public.application_clients c WHERE c.id=NEW.app_id AND c.workspace_id=NEW.workspace_id AND c.module_key NOT IN('native','records') FOR SHARE;
  IF issuance_app.id IS NOT NULL THEN
   PERFORM 1 FROM public.workspaces WHERE id=issuance_app.workspace_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM public.workspace_modules WHERE workspace_id=issuance_app.workspace_id AND module_key=issuance_app.module_key FOR SHARE;
  END IF;
 END;
  IF review.id IS NULL$new3$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.application_reviewed_credential_guard()'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: application_reviewed_credential_guard()';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_apply_activation(uuid)'::regprocedure);
 original:=$old4$ PERFORM id FROM application_clients WHERE id=v.app_id FOR SHARE;
 s:=CASE WHEN v.snapshot->>'profile'='canonical_app_delegation_v1' THEN application_delegation_activation_snapshot(v.app_id) ELSE application_activation_snapshot(v.app_id) END;$old4$;
 replacement:=$new4$ PERFORM id FROM application_clients WHERE id=v.app_id FOR SHARE;
 -- Fresh custom authority shares the lifecycle admission locks until COMMIT.
 DECLARE issuance_app public.application_clients;
 BEGIN
  SELECT c.* INTO issuance_app FROM public.application_clients c WHERE c.id=v.app_id AND c.workspace_id=v.workspace_id AND c.module_key NOT IN('native','records') FOR SHARE;
  IF issuance_app.id IS NOT NULL THEN
   PERFORM 1 FROM public.workspaces WHERE id=issuance_app.workspace_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM public.workspace_modules WHERE workspace_id=issuance_app.workspace_id AND module_key=issuance_app.module_key FOR SHARE;
  END IF;
 END;
 s:=CASE WHEN v.snapshot->>'profile'='canonical_app_delegation_v1' THEN application_delegation_activation_snapshot(v.app_id) ELSE application_activation_snapshot(v.app_id) END;$new4$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.application_apply_activation(uuid)'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: application_apply_activation(uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_scoped_oauth_binding_version()'::regprocedure);
 original:=$old5$BEGIN
 IF EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=NEW.app_id) THEN
 IF EXISTS(SELECT 1 FROM application_clients c WHERE c.id=NEW.app_id AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(c.workspace_id,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled')$old5$;
 replacement:=$new5$BEGIN
 -- Fresh custom authority shares the lifecycle admission locks until COMMIT.
 DECLARE issuance_app public.application_clients;
 BEGIN
  SELECT c.* INTO issuance_app FROM public.application_clients c WHERE c.id=NEW.app_id AND c.workspace_id=NEW.workspace_id AND c.module_key NOT IN('native','records') FOR SHARE;
  IF issuance_app.id IS NOT NULL THEN
   PERFORM 1 FROM public.workspaces WHERE id=issuance_app.workspace_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM public.workspace_modules WHERE workspace_id=issuance_app.workspace_id AND module_key=issuance_app.module_key FOR SHARE;
  END IF;
 END;
 IF EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=NEW.app_id) THEN
 IF EXISTS(SELECT 1 FROM application_clients c WHERE c.id=NEW.app_id AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(c.workspace_id,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled')$new5$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.application_scoped_oauth_binding_version()'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: application_scoped_oauth_binding_version()';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.prepare_source_service_binding(uuid,uuid,uuid,uuid,uuid,timestamptz)'::regprocedure);
 original:=$old6$ IF service IS NULL OR EXISTS(SELECT 1 FROM application_clients c WHERE c.id=app AND c.workspace_id=w AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(w,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled') THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;$old6$;
 replacement:=$new6$ -- Fresh custom authority shares the lifecycle admission locks until COMMIT.
 DECLARE issuance_app public.application_clients;
 BEGIN
  SELECT c.* INTO issuance_app FROM public.application_clients c WHERE c.id=app AND c.workspace_id=w AND c.module_key NOT IN('native','records') FOR SHARE;
  IF issuance_app.id IS NOT NULL THEN
   PERFORM 1 FROM public.workspaces WHERE id=issuance_app.workspace_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM public.workspace_modules WHERE workspace_id=issuance_app.workspace_id AND module_key=issuance_app.module_key FOR SHARE;
  END IF;
 END;
 IF service IS NULL OR EXISTS(SELECT 1 FROM application_clients c WHERE c.id=app AND c.workspace_id=w AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(w,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled') THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;$new6$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.prepare_source_service_binding(uuid,uuid,uuid,uuid,uuid,timestamptz)'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: prepare_source_service_binding(uuid,uuid,uuid,uuid,uuid,timestamptz)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.activate_source_service_binding(uuid,uuid)'::regprocedure);
 original:=$old7$ SELECT * INTO a FROM source_service_binding_approvals WHERE id=approval AND binding_id=b.id FOR UPDATE;
 IF b.id IS NULL OR EXISTS(SELECT 1 FROM application_clients c WHERE c.id=b.app_id AND c.workspace_id=b.workspace_id AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(c.workspace_id,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled')$old7$;
 replacement:=$new7$ SELECT * INTO a FROM source_service_binding_approvals WHERE id=approval AND binding_id=b.id FOR UPDATE;
 -- Fresh custom authority shares the lifecycle admission locks until COMMIT.
 DECLARE issuance_app public.application_clients;
 BEGIN
  SELECT c.* INTO issuance_app FROM public.application_clients c WHERE c.id=b.app_id AND c.workspace_id=b.workspace_id AND c.module_key NOT IN('native','records') FOR SHARE;
  IF issuance_app.id IS NOT NULL THEN
   PERFORM 1 FROM public.workspaces WHERE id=issuance_app.workspace_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM public.workspace_modules WHERE workspace_id=issuance_app.workspace_id AND module_key=issuance_app.module_key FOR SHARE;
  END IF;
 END;
 IF b.id IS NULL OR EXISTS(SELECT 1 FROM application_clients c WHERE c.id=b.app_id AND c.workspace_id=b.workspace_id AND c.module_key NOT IN('native','records') AND (application_deployed_module_state(c.workspace_id,c.module_key)#>>'{moduleLifecycle,state}') IS DISTINCT FROM 'enabled')$new7$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.activate_source_service_binding(uuid,uuid)'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: activate_source_service_binding(uuid,uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.application_apply_native_governance_review(uuid,uuid,uuid)'::regprocedure);
 original:=$old8$ PERFORM pg_advisory_xact_lock(hashtextextended('application-native-governance:'||w::text||':'||review.module_key,0));
 revision:=public.application_native_governance_revision(w,acting,review.module_key);$old8$;
 replacement:=$new8$ PERFORM pg_advisory_xact_lock(hashtextextended('application-native-governance:'||w::text||':'||review.module_key,0));
 -- The existing workspace UPDATE precedes this service-target module SHARE.
 IF review.module_key NOT IN('native','records') AND review.proposal->>'kind'='assign_role'
  AND EXISTS(SELECT 1 FROM public.users u JOIN public.application_clients c ON u.auth_provider='channel'
   AND u.auth_provider_id LIKE 'app-service:'||c.id::text||':%' AND c.workspace_id=w AND c.module_key=review.module_key AND c.status='active'
   WHERE u.id=(review.proposal->>'userId')::uuid) THEN
  PERFORM 1 FROM public.workspace_modules WHERE workspace_id=w AND module_key=review.module_key FOR SHARE;
 END IF;
 revision:=public.application_native_governance_revision(w,acting,review.module_key);$new8$;
 IF (length(definition)-length(replace(definition,original,'')))<>length(original)
  OR (SELECT provolatile FROM pg_proc WHERE oid='public.application_apply_native_governance_review(uuid,uuid,uuid)'::regprocedure)<>'v' THEN
  RAISE EXCEPTION 'module_issuance_lock_prerequisite_changed: application_apply_native_governance_review(uuid,uuid,uuid)';
 END IF;
 EXECUTE replace(definition,original,replacement);
END $upgrade$;
COMMIT;
