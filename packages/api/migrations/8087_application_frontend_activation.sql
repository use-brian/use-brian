-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/application-auth] Verified generic frontend OAuth under exact reviewed current grants.
BEGIN;
ALTER TABLE application_scoped_activations DROP CONSTRAINT application_scoped_activations_profile_check;
ALTER TABLE application_scoped_activations ADD CONSTRAINT application_scoped_activations_profile_check
 CHECK(profile IN('canonical_service_v1','canonical_records_service_v1','canonical_module_service_v1','canonical_records_frontend_v1','canonical_module_frontend_v1'));
ALTER FUNCTION application_scoped_qualified(uuid,uuid) RENAME TO application_scoped_qualified_before_frontend;
REVOKE ALL ON FUNCTION application_scoped_qualified_before_frontend(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION application_scoped_qualified(w uuid,a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT application_scoped_qualified_before_frontend(w,a) OR EXISTS(
 SELECT 1 FROM application_scoped_activations s JOIN application_clients c ON c.id=s.app_id AND c.workspace_id=s.workspace_id
 JOIN assistants agent ON agent.id=s.assistant_id AND agent.workspace_id=s.workspace_id
 JOIN workspace_members issuer ON issuer.workspace_id=s.workspace_id AND issuer.user_id=s.activated_by AND issuer.role IN('owner','admin')
 WHERE s.app_id=a AND s.workspace_id=w AND s.status='active' AND (s.profile='canonical_records_frontend_v1' AND c.module_key='records' OR s.profile='canonical_module_frontend_v1' AND c.module_key NOT IN('native','records') AND s.deployed_snapshot=application_deployed_module_state(w,c.module_key))
 AND c.status='active' AND c.client_mode='external_frontend' AND c.oauth_client_id IS NOT NULL
 AND cardinality(c.origins)>0 AND cardinality(c.redirect_uris)>0 AND c.grant_revision=s.app_revision AND c.executing_assistant_id=s.assistant_id)
$$;
ALTER FUNCTION application_activation_snapshot(uuid) RENAME TO application_activation_snapshot_before_frontend;
REVOKE ALL ON FUNCTION application_activation_snapshot_before_frontend(uuid) FROM PUBLIC;
CREATE FUNCTION application_activation_snapshot(a uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c application_clients;agent assistants;deployed jsonb;
BEGIN
 SELECT * INTO c FROM application_clients WHERE id=a;
 IF c.client_mode IS DISTINCT FROM 'external_frontend' OR c.module_key='native' THEN RETURN application_activation_snapshot_before_frontend(a);END IF;
 IF c.status<>'active' OR c.oauth_client_id IS NULL OR cardinality(c.origins)=0 OR cardinality(c.redirect_uris)=0
 OR application_governance_allows(c.workspace_id) IS NOT TRUE OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO agent FROM assistants WHERE id=c.executing_assistant_id AND workspace_id=c.workspace_id
 AND assistant_placement_visible(nullif(current_setting('app.current_user_id',true),'')::uuid,id);
 IF agent.id IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF c.module_key<>'records' THEN deployed:=application_deployed_module_state(c.workspace_id,c.module_key);IF deployed IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;END IF;
 RETURN jsonb_build_object('profile',CASE WHEN c.module_key='records' THEN 'canonical_records_frontend_v1' ELSE 'canonical_module_frontend_v1' END,'application',to_jsonb(c),'assistant',to_jsonb(agent),'moduleContract',deployed);
END $$;
ALTER FUNCTION application_scoped_grant_allowed(uuid,jsonb) RENAME TO application_scoped_grant_allowed_before_frontend;
REVOKE ALL ON FUNCTION application_scoped_grant_allowed_before_frontend(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_scoped_grant_allowed(a uuid,p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE app application_clients;schema_row entity_types;fields text[];writable text[];target text;capability application_deployed_module_capabilities;
BEGIN
 SELECT * INTO app FROM application_clients WHERE id=a;
 IF app.client_mode IS DISTINCT FROM 'external_frontend' OR app.module_key='native' THEN RETURN application_scoped_grant_allowed_before_frontend(a,p);END IF;
 IF application_scoped_qualified(app.workspace_id,a) IS NOT TRUE OR p->'principal'->>'kind' NOT IN('member','external_user') THEN RETURN false;END IF;
 IF app.module_key<>'records' AND (p->'principal'->>'kind' IS DISTINCT FROM 'member' OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=app.workspace_id AND m.user_id=(p->'principal'->>'userId')::uuid)) THEN RETURN false;END IF;
 SELECT * INTO capability FROM application_deployed_module_capabilities WHERE module_key=app.module_key;
 IF app.module_key<>'records' AND capability.module_key IS NULL THEN RETURN false;END IF;
 IF p->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb THEN
 target:=CASE p->>'typeKey' WHEN 'person' THEN 'contact' ELSE p->>'typeKey' END;
 RETURN p->>'typeKey' IN('company','person','deal','task') AND p->'selector'->>'kind'='ids' AND p->'actions'='["read"]'::jsonb
 AND p->'readFields'='[]'::jsonb AND p->'writeFields'='[]'::jsonb
 AND EXISTS(SELECT 1 FROM entity_types t,LATERAL jsonb_array_elements(t.properties) field WHERE t.workspace_id=app.workspace_id
 AND (app.module_key='records' OR 'native'=ANY(capability.dependencies) AND EXISTS(SELECT 1 FROM application_native_resource_owners owner WHERE owner.workspace_id=t.workspace_id AND owner.module_key=app.module_key AND owner.origin=jsonb_build_object('kind','generic','entityTypeId',t.id)))
 AND field->'config'->>'kind'='relation' AND field->'config'->'targetEntityTypeRef'->>'kind'='builtin' AND field->'config'->'targetEntityTypeRef'->>'name'=target);
 END IF;
 IF p->'origin'->>'kind' IS DISTINCT FROM 'generic' OR p->'selector'->>'kind' NOT IN('self','ids') THEN RETURN false;END IF;
 SELECT * INTO schema_row FROM entity_types WHERE id=(p->'origin'->>'entityTypeId')::uuid AND workspace_id=app.workspace_id;
 IF schema_row.id IS NULL OR app.module_key<>'records' AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners owner WHERE owner.workspace_id=app.workspace_id AND owner.module_key=app.module_key AND owner.origin=p->'origin' AND owner.resource_type=p->>'typeKey') OR p->'origin' IS DISTINCT FROM jsonb_build_object('kind','generic','entityTypeId',schema_row.id)
 OR p->>'typeKey' IS DISTINCT FROM 'record.'||schema_row.id::text THEN RETURN false;END IF;
 fields:=ARRAY(SELECT property->>'name' FROM jsonb_array_elements(schema_row.properties) property);
 writable:=ARRAY(SELECT property->>'name' FROM jsonb_array_elements(schema_row.properties) property WHERE property->'config'->>'kind' NOT IN('created_time','created_by','last_edited_time','last_edited_by'));
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action WHERE
 CASE WHEN app.module_key='records' THEN action NOT IN('read','query','history','schema','create','patch','delete','command:record_create','command:record_patch','command:record_delete','command:record_batch')
 ELSE action NOT IN('read','query','history','schema','create','patch','delete') AND NOT(action LIKE 'command:%' AND substring(action FROM 9)=ANY(capability.commands)) END)
 AND p->'readFields'<@to_jsonb(fields) AND p->'writeFields'<@to_jsonb(writable);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
ALTER TABLE application_oauth_bindings ADD COLUMN activation_version uuid;
CREATE FUNCTION application_scoped_oauth_binding_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=NEW.app_id) THEN
 IF NOT EXISTS(SELECT 1 FROM application_scoped_activations s WHERE s.app_id=NEW.app_id AND s.profile IN('canonical_records_frontend_v1','canonical_module_frontend_v1') AND application_scoped_qualified(NEW.workspace_id,NEW.app_id)) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 SELECT version INTO NEW.activation_version FROM application_scoped_activations WHERE app_id=NEW.app_id FOR SHARE;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_scoped_oauth_binding_version() FROM PUBLIC;
CREATE TRIGGER application_scoped_oauth_binding_version BEFORE INSERT ON application_oauth_bindings FOR EACH ROW EXECUTE FUNCTION application_scoped_oauth_binding_version();
CREATE FUNCTION application_frontend_oauth_generation_current(a uuid,o uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM application_oauth_bindings b JOIN application_scoped_activations s ON s.app_id=b.app_id AND s.version=b.activation_version
 JOIN oauth_authorizations oa ON oa.id=b.authorization_id AND oa.application_client_id=b.app_id AND oa.workspace_id=b.workspace_id AND oa.user_id=b.principal_user_id AND oa.audience='application' AND oa.revoked_at IS NULL
 WHERE b.app_id=a AND b.authorization_id=o AND s.profile IN('canonical_records_frontend_v1','canonical_module_frontend_v1') AND application_scoped_qualified(b.workspace_id,a))
$$;
ALTER FUNCTION application_oauth_binding_current(uuid,uuid) RENAME TO application_oauth_binding_current_before_frontend;
REVOKE ALL ON FUNCTION application_oauth_binding_current_before_frontend(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION application_oauth_binding_current(authorization_id uuid,application_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT application_oauth_binding_current_before_frontend(authorization_id,application_id) AND
 (EXISTS(SELECT 1 FROM application_oauth_bindings b WHERE b.authorization_id=application_oauth_binding_current.authorization_id AND b.app_id=application_id AND b.activation_version IS NULL)
 AND NOT EXISTS(SELECT 1 FROM application_scoped_activations s WHERE s.app_id=application_id)
 OR application_frontend_oauth_generation_current(application_id,authorization_id))
$$;
ALTER FUNCTION application_scoped_credential_current(uuid,uuid) RENAME TO application_scoped_credential_current_before_frontend;
REVOKE ALL ON FUNCTION application_scoped_credential_current_before_frontend(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION application_scoped_credential_current(a uuid,c uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o uuid:=nullif(current_setting('app.application_oauth_id',true),'')::uuid;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF c IS NULL AND EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=a AND profile IN('canonical_records_frontend_v1','canonical_module_frontend_v1')) THEN
 RETURN application_oauth_binding_current(o,a) AND EXISTS(SELECT 1 FROM application_oauth_bindings b WHERE b.authorization_id=o AND b.app_id=a AND b.principal_user_id=actor);
 END IF;
 RETURN application_scoped_credential_current_before_frontend(a,c);
END $$;
ALTER FUNCTION application_oauth_consent_snapshot(uuid,uuid,uuid[]) RENAME TO application_oauth_consent_snapshot_before_frontend;
REVOKE ALL ON FUNCTION application_oauth_consent_snapshot_before_frontend(uuid,uuid,uuid[]) FROM PUBLIC;
CREATE FUNCTION application_oauth_consent_snapshot(application_id uuid,subject_id uuid,grant_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT application_oauth_consent_snapshot_before_frontend(application_id,subject_id,grant_ids)||jsonb_build_object('activationVersion',(SELECT s.version::text FROM application_scoped_activations s WHERE s.app_id=application_id))
$$;
DO $extend$ DECLARE definition text;original text;BEGIN
 definition:=pg_get_functiondef('application_apply_activation(uuid)'::regprocedure);
 original:=$old$'canonical_service_v1','canonical_records_service_v1','canonical_module_service_v1'$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'frontend_activation_profiles_changed';END IF;
 EXECUTE replace(definition,original,$new$'canonical_service_v1','canonical_records_service_v1','canonical_module_service_v1','canonical_records_frontend_v1','canonical_module_frontend_v1'$new$);
 definition:=pg_get_functiondef('application_current_maxima_before_scoped()'::regprocedure);
 original:=$old$IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=actor AND u.auth_provider<>'channel') THEN RETURN NULL; END IF;$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'frontend_current_oauth_branch_changed';END IF;
 EXECUTE replace(definition,original,$new$IF NOT FOUND OR application_oauth_binding_current(oauth.id,app.id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=actor AND u.auth_provider<>'channel') THEN RETURN NULL; END IF;$new$);
 definition:=pg_get_functiondef('application_scoped_reference_grant_allowed(uuid,jsonb)'::regprocedure);
 original:=$old$p->'principal'->>'kind'='service' AND p->'origin'$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_frontend_reference_principal_changed';END IF;
 EXECUTE replace(definition,original,$new$(p->'principal'->>'kind'='service' OR p->'principal'->>'kind'='member'
 AND app.client_mode='external_frontend' AND EXISTS(SELECT 1 FROM application_scoped_activations activation WHERE activation.app_id=app.id AND activation.profile='canonical_module_frontend_v1')
 AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=app.workspace_id AND member.user_id=(p->'principal'->>'userId')::uuid)) AND p->'origin'$new$);
END $extend$;
ALTER POLICY application_oauth_binding_create ON application_oauth_bindings WITH CHECK(principal_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND (application_runtime_qualified(workspace_id,'application_data') OR application_scoped_qualified(workspace_id,app_id)));
ALTER POLICY application_oauth_subject_create ON oauth_authorizations WITH CHECK(audience='application' AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
 AND (application_runtime_qualified(workspace_id,'application_data') OR application_scoped_qualified(workspace_id,application_client_id))
 AND EXISTS(SELECT 1 FROM application_access_grants g WHERE g.app_id=application_client_id AND g.workspace_id=oauth_authorizations.workspace_id AND g.principal_user_id=oauth_authorizations.user_id AND g.status='active' AND g.starts_at<=now() AND (g.expires_at IS NULL OR g.expires_at>now())));
ALTER POLICY application_oauth_subject_revoke ON oauth_authorizations WITH CHECK(audience='application' AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND (revoked_at IS NOT NULL OR application_runtime_qualified(workspace_id,'application_data') OR application_scoped_qualified(workspace_id,application_client_id)));
REVOKE ALL ON FUNCTION application_scoped_qualified(uuid,uuid),application_activation_snapshot(uuid),application_scoped_grant_allowed(uuid,jsonb),application_frontend_oauth_generation_current(uuid,uuid),application_oauth_binding_current(uuid,uuid),application_scoped_credential_current(uuid,uuid),application_oauth_consent_snapshot(uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION application_scoped_qualified_before_frontend(uuid,uuid),application_activation_snapshot_before_frontend(uuid),application_scoped_grant_allowed_before_frontend(uuid,jsonb),application_oauth_binding_current_before_frontend(uuid,uuid),application_scoped_credential_current_before_frontend(uuid,uuid),application_oauth_consent_snapshot_before_frontend(uuid,uuid,uuid[]) FROM app_user;
 GRANT EXECUTE ON FUNCTION application_scoped_qualified(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb),application_oauth_binding_current(uuid,uuid),application_scoped_credential_current(uuid,uuid),application_oauth_consent_snapshot(uuid,uuid,uuid[]) TO app_user;
END IF;END $$;
COMMIT;
