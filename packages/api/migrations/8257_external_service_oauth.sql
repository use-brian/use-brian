BEGIN;
CREATE TABLE external_services (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 oauth_client_id text NOT NULL UNIQUE REFERENCES oauth_clients(client_id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 redirect_uris text[] NOT NULL CHECK(cardinality(redirect_uris) BETWEEN 1 AND 10),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked')),
 created_by_user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id)
);
ALTER TABLE external_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY external_services_manage ON external_services FOR ALL USING(EXISTS(
 SELECT 1 FROM workspace_members m WHERE m.workspace_id=external_services.workspace_id
 AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN('owner','admin')))
 WITH CHECK(EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=external_services.workspace_id
 AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN('owner','admin')));
ALTER TABLE oauth_authorizations ADD COLUMN external_service_id uuid REFERENCES external_services(id) ON DELETE CASCADE,
 ADD COLUMN external_service_revision bigint,
 DROP CONSTRAINT oauth_authorizations_audience_check,
 DROP CONSTRAINT oauth_application_audience_binding;
ALTER TABLE oauth_authorizations ADD CONSTRAINT oauth_authorizations_audience_check CHECK(audience IN('brain','application','assistant','service')),
 ADD CONSTRAINT oauth_application_audience_binding CHECK(
 (audience='brain' AND application_client_id IS NULL AND bound_assistant_id IS NULL AND external_service_id IS NULL AND external_service_revision IS NULL)
 OR (audience='application' AND application_client_id IS NOT NULL AND bound_assistant_id IS NULL AND workspace_mcp_consent IS NULL AND external_service_id IS NULL AND external_service_revision IS NULL)
 OR (audience='assistant' AND application_client_id IS NULL AND bound_assistant_id IS NOT NULL AND workspace_mcp_consent IS NOT NULL AND external_service_id IS NULL AND external_service_revision IS NULL)
 OR (audience='service' AND application_client_id IS NULL AND bound_assistant_id IS NULL AND workspace_mcp_consent IS NULL AND external_service_id IS NOT NULL AND external_service_revision IS NOT NULL));
CREATE FUNCTION external_service_oauth_current(authorization_id uuid,service_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM oauth_authorizations a JOIN external_services s ON s.id=a.external_service_id
   AND s.workspace_id=a.workspace_id AND s.oauth_client_id=a.client_id AND s.revision=a.external_service_revision AND s.status='active'
 JOIN oauth_clients c ON c.client_id=a.client_id AND c.revoked_at IS NULL
 JOIN workspace_members m ON m.workspace_id=a.workspace_id AND m.user_id=a.user_id
 JOIN users u ON u.id=m.user_id AND u.auth_provider<>'channel'
 WHERE a.id=authorization_id AND a.audience='service' AND s.id=service_id AND a.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION external_service_oauth_current(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION external_service_oauth_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.external_service_id IS DISTINCT FROM OLD.external_service_id
 OR NEW.external_service_revision IS DISTINCT FROM OLD.external_service_revision
 OR OLD.audience='service' AND (ROW(NEW.user_id,NEW.workspace_id,NEW.client_id,NEW.scope) IS DISTINCT FROM ROW(OLD.user_id,OLD.workspace_id,OLD.client_id,OLD.scope)
 OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL)) THEN RAISE EXCEPTION 'external_service_oauth_immutable'; END IF;
 IF TG_OP='INSERT' AND NEW.audience='service' AND NOT EXISTS(SELECT 1 FROM external_services s
 JOIN workspace_members m ON m.workspace_id=s.workspace_id AND m.user_id=NEW.user_id
 JOIN users u ON u.id=m.user_id AND u.auth_provider<>'channel'
 WHERE s.id=NEW.external_service_id AND s.workspace_id=NEW.workspace_id AND s.oauth_client_id=NEW.client_id
 AND s.revision=NEW.external_service_revision AND s.status='active' AND NEW.code_redirect_uri=ANY(s.redirect_uris))
 THEN RAISE EXCEPTION 'external_service_access_unavailable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION external_service_oauth_guard() FROM PUBLIC;
CREATE TRIGGER external_service_oauth_guard BEFORE INSERT OR UPDATE ON oauth_authorizations FOR EACH ROW EXECUTE FUNCTION external_service_oauth_guard();
CREATE POLICY external_service_oauth_self_revoke ON oauth_authorizations FOR UPDATE USING(audience='service' AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
 WITH CHECK(audience='service' AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND revoked_at IS NOT NULL AND access_token_hash IS NULL AND refresh_token_hash IS NULL AND code_hash IS NULL);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT SELECT,INSERT,UPDATE ON external_services TO app_user;
 END IF; END $$;
COMMIT;
