-- Spec: docs/architecture/features/application-platform.md#explicit-reviewed-application-delegation
-- [COMP:api/application-auth] Explicit reviewed composition; existing profiles keep their limits.
BEGIN;
ALTER TABLE application_scoped_activations DROP CONSTRAINT application_scoped_activations_profile_check;
ALTER TABLE application_scoped_activations ADD CONSTRAINT application_scoped_activations_profile_check
 CHECK(profile IN('canonical_service_v1','canonical_records_service_v1','canonical_module_service_v1','canonical_records_frontend_v1','canonical_module_frontend_v1','canonical_app_delegation_v1'));
CREATE FUNCTION application_delegation_activation_snapshot(a uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb;
BEGIN
 s:=application_activation_snapshot(a);
 IF s->>'profile' NOT IN('canonical_records_frontend_v1','canonical_module_frontend_v1') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN s||jsonb_build_object('profile','canonical_app_delegation_v1');
END $$;
CREATE FUNCTION application_prepare_activation(a uuid,profile text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb;r uuid;
BEGIN
 IF profile IS DISTINCT FROM 'canonical_app_delegation_v1' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 s:=application_delegation_activation_snapshot(a);
 INSERT INTO application_activation_reviews(app_id,workspace_id,actor_id,snapshot) VALUES(a,(s#>>'{application,workspace_id}')::uuid,nullif(current_setting('app.current_user_id',true),'')::uuid,s) RETURNING id INTO r;
 RETURN r;
END $$;
DO $upgrade$ DECLARE definition text;original text;replacement text;BEGIN
 definition:=pg_get_functiondef('application_scoped_qualified(uuid,uuid)'::regprocedure);
 original:=$old$s.profile='canonical_records_frontend_v1' AND c.module_key='records' OR s.profile='canonical_module_frontend_v1' AND c.module_key NOT IN('native','records') AND s.deployed_snapshot=application_deployed_module_state(w,c.module_key)$old$;replacement:=$new$s.profile IN('canonical_records_frontend_v1','canonical_app_delegation_v1') AND c.module_key='records' OR s.profile IN('canonical_module_frontend_v1','canonical_app_delegation_v1') AND c.module_key NOT IN('native','records') AND s.deployed_snapshot=application_deployed_module_state(w,c.module_key)$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_scoped_qualified(uuid,uuid)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_apply_activation(uuid)'::regprocedure);
 original:=$old$s:=application_activation_snapshot(v.app_id);$old$;replacement:=$new$s:=CASE WHEN v.snapshot->>'profile'='canonical_app_delegation_v1' THEN application_delegation_activation_snapshot(v.app_id) ELSE application_activation_snapshot(v.app_id) END;$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_apply_activation(uuid)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_apply_activation(uuid)'::regprocedure);
 original:=$old$'canonical_service_v1','canonical_records_service_v1','canonical_module_service_v1','canonical_records_frontend_v1','canonical_module_frontend_v1'$old$;replacement:=$new$'canonical_service_v1','canonical_records_service_v1','canonical_module_service_v1','canonical_records_frontend_v1','canonical_module_frontend_v1','canonical_app_delegation_v1'$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_apply_activation(uuid)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_scoped_grant_allowed(uuid,jsonb)'::regprocedure);
 original:=$old$p->'principal'->>'kind' NOT IN('member','external_user')$old$;replacement:=$new$(p->'principal'->>'kind' NOT IN('member','external_user') AND NOT(p->'principal'->>'kind'='service' AND EXISTS(SELECT 1 FROM application_scoped_activations s WHERE s.app_id=a AND s.profile='canonical_app_delegation_v1')))$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_scoped_grant_allowed(uuid,jsonb)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_scoped_grant_allowed(uuid,jsonb)'::regprocedure);
 original:=$old$IF app.module_key<>'records' AND (p->'principal'->>'kind' IS DISTINCT FROM 'member' OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=app.workspace_id AND m.user_id=(p->'principal'->>'userId')::uuid))$old$;replacement:=$new$IF app.module_key<>'records' AND NOT(p->'principal'->>'kind'='service' AND EXISTS(SELECT 1 FROM application_scoped_activations s WHERE s.app_id=a AND s.profile='canonical_app_delegation_v1')) AND (p->'principal'->>'kind' IS DISTINCT FROM 'member' OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=app.workspace_id AND m.user_id=(p->'principal'->>'userId')::uuid))$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_scoped_grant_allowed(uuid,jsonb)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_scoped_credential_allowed(uuid,jsonb)'::regprocedure);
 original:=$old$p->>'kind'='service'$old$;replacement:=$new$(p->>'kind'='service' OR p->>'kind'='delegated' AND EXISTS(SELECT 1 FROM application_scoped_activations s WHERE s.app_id=a AND s.profile='canonical_app_delegation_v1'))$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_scoped_credential_allowed(uuid,jsonb)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_scoped_oauth_binding_version()'::regprocedure);
 original:=$old$'canonical_records_frontend_v1','canonical_module_frontend_v1'$old$;replacement:=$new$'canonical_records_frontend_v1','canonical_module_frontend_v1','canonical_app_delegation_v1'$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_scoped_oauth_binding_version()';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_frontend_oauth_generation_current(uuid,uuid)'::regprocedure);
 original:=$old$'canonical_records_frontend_v1','canonical_module_frontend_v1'$old$;replacement:=$new$'canonical_records_frontend_v1','canonical_module_frontend_v1','canonical_app_delegation_v1'$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_frontend_oauth_generation_current(uuid,uuid)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_scoped_credential_current(uuid,uuid)'::regprocedure);
 original:=$old$'canonical_records_frontend_v1','canonical_module_frontend_v1'$old$;replacement:=$new$'canonical_records_frontend_v1','canonical_module_frontend_v1','canonical_app_delegation_v1'$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_scoped_credential_current(uuid,uuid)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_scoped_credential_current(uuid,uuid)'::regprocedure);
 original:=$old$ IF c IS NULL AND EXISTS$old$;replacement:=$new$ IF c IS NOT NULL AND EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=a AND profile='canonical_app_delegation_v1') THEN
 RETURN EXISTS(SELECT 1 FROM application_api_credentials k JOIN application_scoped_activations s ON s.app_id=k.app_id AND s.version=k.activation_version
 WHERE k.id=c AND k.app_id=a AND application_scoped_qualified(s.workspace_id,a)
 AND k.credential_kind IN('service','delegated')); -- Generation metadata only; host proof and application_current_maxima require current OAuth for delegated data access.
 END IF;
 IF c IS NULL AND EXISTS$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_scoped_credential_current(uuid,uuid)';END IF;
 EXECUTE replace(definition,original,replacement);
 definition:=pg_get_functiondef('application_scoped_reference_grant_allowed(uuid,jsonb)'::regprocedure);
 original:=$old$activation.profile='canonical_module_frontend_v1'$old$;replacement:=$new$activation.profile IN('canonical_module_frontend_v1','canonical_app_delegation_v1')$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'delegation_prerequisite_changed: application_scoped_reference_grant_allowed(uuid,jsonb)';END IF;
 EXECUTE replace(definition,original,replacement);
END $upgrade$;
REVOKE ALL ON FUNCTION application_delegation_activation_snapshot(uuid),application_prepare_activation(uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION application_prepare_activation(uuid,text) TO app_user;
END IF;END $$;
COMMIT;
