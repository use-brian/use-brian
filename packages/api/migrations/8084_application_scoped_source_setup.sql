-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/source-service-binding] Reviewed app-scoped source setup; no global trust activation.
BEGIN;
ALTER TABLE connector_source_profiles ADD COLUMN scoped_app_id uuid REFERENCES application_clients(id) ON DELETE CASCADE;
CREATE FUNCTION guard_scoped_source_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN IF TG_OP='UPDATE' AND NEW.scoped_app_id IS DISTINCT FROM OLD.scoped_app_id THEN RAISE EXCEPTION 'source_scope_immutable' USING ERRCODE='22023';END IF;RETURN NEW;END $$;
CREATE TRIGGER scoped_source_profile_immutable BEFORE UPDATE ON connector_source_profiles FOR EACH ROW EXECUTE FUNCTION guard_scoped_source_profile();
REVOKE ALL ON FUNCTION guard_scoped_source_profile() FROM PUBLIC;
CREATE TABLE application_source_setup_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile_id uuid NOT NULL DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 app_id uuid NOT NULL REFERENCES application_clients(id) ON DELETE CASCADE,actor_id uuid NOT NULL REFERENCES users(id),
 proposal jsonb NOT NULL,snapshot text NOT NULL,expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',consumed boolean NOT NULL DEFAULT false
);
ALTER TABLE application_source_setup_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_source_setup_review_read ON application_source_setup_reviews FOR SELECT USING(actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND application_governance_allows(workspace_id));
CREATE TABLE application_source_setup_approvals (
 id uuid PRIMARY KEY,review_id uuid NOT NULL REFERENCES application_source_setup_reviews(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),snapshot text NOT NULL,observations jsonb NOT NULL,expires_at timestamptz NOT NULL
);
ALTER TABLE application_source_setup_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_source_setup_reviews,application_source_setup_approvals FROM PUBLIC;
CREATE FUNCTION application_source_setup_snapshot(w uuid,a uuid,i uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(to_jsonb(c),to_jsonb(ci),to_jsonb(agent),s.version)::text,'UTF8')),'hex')
 FROM application_clients c JOIN application_scoped_activations s ON s.app_id=c.id JOIN assistants agent ON agent.id=c.executing_assistant_id AND agent.workspace_id=w
 JOIN connector_instance ci ON ci.id=i AND ci.scope='workspace' AND ci.workspace_id=w AND ci.connected AND ci.health_status<>'auth_failed'
 WHERE c.id=a AND c.workspace_id=w AND application_scoped_qualified(w,a) AND application_governance_allows(w)
 AND nullif(current_setting('app.application_id',true),'') IS NULL
$$;
CREATE FUNCTION application_prepare_source_setup(w uuid,a uuid,p jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE snapshot text;r uuid;
BEGIN
 snapshot:=application_source_setup_snapshot(w,a,(p->>'instanceId')::uuid);
 IF snapshot IS NULL THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 INSERT INTO application_source_setup_reviews(workspace_id,app_id,actor_id,proposal,snapshot)
 VALUES(w,a,nullif(current_setting('app.current_user_id',true),'')::uuid,p,snapshot) RETURNING id INTO r;RETURN r;
END $$;
CREATE FUNCTION application_apply_source_setup(r uuid,approval_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v application_source_setup_reviews;a application_source_setup_approvals;o jsonb;resource_id uuid;
BEGIN
 SELECT * INTO v FROM application_source_setup_reviews WHERE id=r AND actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid FOR UPDATE;
 IF v.id IS NULL OR application_governance_allows(v.workspace_id) IS NOT TRUE THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 IF v.consumed THEN
 IF NOT EXISTS(SELECT 1 FROM connector_source_profiles p WHERE p.id=v.profile_id AND p.scoped_app_id=v.app_id AND p.status='qualified') THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 RETURN v.profile_id;END IF;
 SELECT * INTO a FROM application_source_setup_approvals WHERE id=approval_id AND review_id=r AND actor_id=v.actor_id FOR UPDATE;
 IF v.expires_at<=clock_timestamp() OR a.id IS NULL OR a.expires_at<=clock_timestamp() OR a.snapshot IS DISTINCT FROM v.snapshot
 OR v.snapshot IS DISTINCT FROM application_source_setup_snapshot(v.workspace_id,v.app_id,(v.proposal->>'instanceId')::uuid)
 OR jsonb_array_length(a.observations)<>1 THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 INSERT INTO connector_source_profiles(id,workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id,scoped_app_id)
 VALUES(v.profile_id,v.workspace_id,(v.proposal->>'instanceId')::uuid,v.proposal->>'tenant',v.proposal->>'issuer',v.proposal->>'audience',v.proposal->>'sourceBaseUrl',v.proposal->>'mcpUrl','/http/read','qualified',v.actor_id,v.app_id);
 FOR o IN SELECT value FROM jsonb_array_elements(a.observations) LOOP
 INSERT INTO external_source_resources(workspace_id,profile_id,resource_type,opaque_id)
 VALUES(v.workspace_id,v.profile_id,o#>>'{observation,resource,type}',o#>>'{observation,resource,id}') RETURNING id INTO resource_id;
 INSERT INTO external_source_observations(workspace_id,resource_id,version,content_version,policy_version,fields,observation,sensitivity,compartments,project_ids)
 VALUES(v.workspace_id,resource_id,o->>'version',o#>>'{observation,resource,contentVersion}',o#>>'{observation,resource,policyVersion}',ARRAY(SELECT jsonb_array_elements_text(o#>'{observation,fields}')),o->'observation',o->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(o->'compartments')),ARRAY(SELECT jsonb_array_elements_text(o->'projectIds')::uuid));
 END LOOP;
 UPDATE application_source_setup_reviews SET consumed=true WHERE id=r;DELETE FROM application_source_setup_approvals WHERE id=a.id;RETURN v.profile_id;
END $$;
-- Extend the compiled service profile only to this app's reviewed governed source reads.
ALTER FUNCTION application_scoped_grant_allowed(uuid,jsonb) RENAME TO application_scoped_native_grant_allowed;
REVOKE ALL ON FUNCTION application_scoped_native_grant_allowed(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_scoped_grant_allowed(a uuid,p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p->'origin'->>'kind' IS DISTINCT FROM 'external' THEN RETURN application_scoped_native_grant_allowed(a,p);END IF;
 RETURN p->'principal'->>'kind'='service' AND p->'selector'->>'kind'='ids'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action WHERE action NOT IN('read','command:source.derive','command:source.retain'))
 AND p->'writeFields'='[]'::jsonb
 AND EXISTS(SELECT 1 FROM connector_source_profiles s WHERE s.scoped_app_id=a AND s.connector_instance_id=(p->'origin'->>'connectorInstanceId')::uuid
 AND s.tenant=(p->'origin'->>'sourceTenant') AND s.status='qualified' AND application_scoped_qualified(s.workspace_id,a));
END $$;
ALTER FUNCTION source_service_authority_fingerprint(uuid,uuid,uuid,uuid,uuid,uuid) RENAME TO source_service_authority_fingerprint_before_scoped;
REVOKE ALL ON FUNCTION source_service_authority_fingerprint_before_scoped(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
CREATE FUNCTION source_service_authority_fingerprint(w uuid,p uuid,a uuid,c uuid,s uuid,assistant uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE base text;generation uuid;
BEGIN
 IF application_scoped_credential_current(a,c) IS NOT TRUE THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM connector_source_profiles WHERE id=p AND scoped_app_id IS NOT NULL AND scoped_app_id<>a) THEN RETURN NULL;END IF;
 base:=source_service_authority_fingerprint_before_scoped(w,p,a,c,s,assistant);IF base IS NULL THEN RETURN NULL;END IF;
 SELECT version INTO generation FROM application_scoped_activations WHERE app_id=a;
 RETURN CASE WHEN generation IS NULL THEN base ELSE encode(sha256(convert_to(base||generation::text,'UTF8')),'hex') END;
END $$;
DO $activation$ DECLARE definition text;original text;BEGIN
 definition:=pg_get_functiondef('activate_source_service_binding(uuid,uuid)'::regprocedure);
 original:=$old$application_runtime_qualified(b.workspace_id,'application_data') IS NOT TRUE OR application_runtime_qualified(b.workspace_id,'connector_source') IS NOT TRUE$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'source_binding_activation_changed';END IF;
 EXECUTE replace(definition,original,$new$(NOT(application_runtime_qualified(b.workspace_id,'application_data') AND application_runtime_qualified(b.workspace_id,'connector_source')) AND NOT(application_scoped_qualified(b.workspace_id,b.app_id) AND EXISTS(SELECT 1 FROM connector_source_profiles p WHERE p.id=b.profile_id AND p.scoped_app_id=b.app_id AND p.status='qualified')))$new$);
END $activation$;
-- Shared native/dependency readers cannot turn scoped source status into attended access.
ALTER FUNCTION external_source_snapshot(uuid,uuid) RENAME TO external_source_snapshot_before_scoped;
REVOKE ALL ON FUNCTION external_source_snapshot_before_scoped(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION external_source_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a uuid;b uuid:=nullif(current_setting('app.external_source_service_binding_id',true),'')::uuid;
BEGIN
 SELECT p.scoped_app_id INTO a FROM external_source_observations o JOIN external_source_resources r ON r.id=o.resource_id JOIN connector_source_profiles p ON p.id=r.profile_id WHERE o.id=i AND o.workspace_id=w;
 IF a IS NOT NULL AND (source_service_binding_admitted(b,w) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM source_service_bindings binding WHERE binding.id=b AND binding.app_id=a)) THEN RETURN '{"held":true}'::jsonb;END IF;
 RETURN external_source_snapshot_before_scoped(w,i);
END $$;
REVOKE ALL ON FUNCTION external_source_snapshot(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION revoke_source_service_binding(w uuid,a uuid,b uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF application_governance_allows(w) IS NOT TRUE OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 UPDATE source_service_bindings SET status='revoked' WHERE id=b AND app_id=a AND workspace_id=w AND status<>'revoked';RETURN FOUND;END $$;
REVOKE ALL ON FUNCTION application_source_setup_snapshot(uuid,uuid,uuid),application_prepare_source_setup(uuid,uuid,jsonb),application_apply_source_setup(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb),source_service_authority_fingerprint(uuid,uuid,uuid,uuid,uuid,uuid),revoke_source_service_binding(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION external_source_snapshot_before_scoped(uuid,uuid) FROM app_user;
 GRANT EXECUTE ON FUNCTION external_source_snapshot(uuid,uuid) TO app_user;
 GRANT SELECT ON application_source_setup_reviews TO app_user;
 GRANT EXECUTE ON FUNCTION application_source_setup_snapshot(uuid,uuid,uuid),application_prepare_source_setup(uuid,uuid,jsonb),application_apply_source_setup(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb),revoke_source_service_binding(uuid,uuid,uuid) TO app_user;
END IF;END $$;
COMMIT;
