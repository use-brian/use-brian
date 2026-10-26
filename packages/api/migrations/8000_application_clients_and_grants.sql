BEGIN;

CREATE TABLE application_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_key text NOT NULL CHECK(module_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  client_mode text NOT NULL CHECK(client_mode IN('home_app','external_frontend','api_client')),
  origins text[] NOT NULL DEFAULT '{}',
  redirect_uris text[] NOT NULL DEFAULT '{}',
  home_app_id uuid REFERENCES workspace_home_apps(id) ON DELETE SET NULL,
  oauth_client_id text REFERENCES oauth_clients(client_id) ON DELETE SET NULL,
  executing_assistant_id uuid REFERENCES assistants(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended','revoked')),
  grant_revision bigint NOT NULL DEFAULT 1 CHECK(grant_revision>0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,workspace_id),
  CHECK(cardinality(origins)<=16 AND cardinality(redirect_uris)<=16),
  CHECK(home_app_id IS NULL OR client_mode='home_app')
);
CREATE UNIQUE INDEX application_client_home_link ON application_clients(home_app_id) WHERE home_app_id IS NOT NULL;

CREATE TABLE application_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_kind text NOT NULL CHECK(principal_kind IN('member','external_user','service')),
  principal_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_by_user_id uuid NOT NULL REFERENCES users(id),
  resource_origin jsonb NOT NULL CHECK(jsonb_typeof(resource_origin)='object'),
  resource_type text NOT NULL CHECK(resource_type ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  actions text[] NOT NULL CHECK(cardinality(actions) BETWEEN 1 AND 128),
  read_fields text[] NOT NULL DEFAULT '{}' CHECK(cardinality(read_fields)<=128),
  write_fields text[] NOT NULL DEFAULT '{}' CHECK(cardinality(write_fields)<=128),
  selector jsonb NOT NULL CHECK(jsonb_typeof(selector)='object' AND selector->>'kind' IN('ids','self','relationship')),
  compartments text[] NOT NULL,
  project_ids uuid[] NOT NULL,
  clearance text NOT NULL CHECK(clearance IN('public','internal','confidential')),
  parent_grant_id uuid REFERENCES application_access_grants(id) DEFERRABLE INITIALLY DEFERRED,
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended','revoked')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(app_id,workspace_id) REFERENCES application_clients(id,workspace_id) ON DELETE CASCADE,
  UNIQUE(id,app_id,workspace_id),
  CHECK(expires_at IS NULL OR expires_at>starts_at),
  CHECK(parent_grant_id IS NULL OR parent_grant_id<>id)
);
CREATE INDEX application_grant_subject ON application_access_grants(app_id,principal_user_id,status);

-- Replaced by P4's tested coverage/source/legacy-review qualification adapter.
-- No API, environment flag or administrator parameter can turn this deny on.
CREATE FUNCTION application_runtime_qualified(w uuid,profile text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE FUNCTION application_governance_allows(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w
    AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN('owner','admin'));
$$;

CREATE FUNCTION application_client_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' AND nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
    AND NEW.created_by_user_id::text<>current_setting('app.current_user_id',true) THEN
    RAISE EXCEPTION 'invalid_value: application issuer mismatch' USING ERRCODE='22023';
  END IF;
  IF NEW.executing_assistant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assistants a WHERE a.id=NEW.executing_assistant_id AND a.workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'invalid_value: application assistant unavailable' USING ERRCODE='22023';
  END IF;
  IF NEW.home_app_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_home_apps h WHERE h.id=NEW.home_app_id AND h.workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'invalid_value: Home app unavailable' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.module_key<>OLD.module_key OR NEW.created_by_user_id<>OLD.created_by_user_id THEN
      RAISE EXCEPTION 'invalid_value: immutable application identity' USING ERRCODE='22023';
    END IF;
    NEW.grant_revision:=OLD.grant_revision+1;NEW.updated_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER application_client_guard BEFORE INSERT OR UPDATE ON application_clients FOR EACH ROW EXECUTE FUNCTION application_client_guard();

CREATE FUNCTION application_grant_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE provider text; provider_id text; parent application_access_grants;
BEGIN
  IF TG_OP='INSERT' AND nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
    AND NEW.issued_by_user_id::text<>current_setting('app.current_user_id',true) THEN
    RAISE EXCEPTION 'invalid_value: grant issuer mismatch' USING ERRCODE='22023';
  END IF;
  SELECT auth_provider,auth_provider_id INTO provider,provider_id FROM users WHERE id=NEW.principal_user_id;
  IF NEW.status='active' AND (provider IS NULL OR NEW.principal_kind='member' AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.principal_user_id)
    OR NEW.principal_kind='external_user' AND provider='channel'
    OR NEW.principal_kind='service' AND (provider<>'channel' OR provider_id NOT LIKE 'app-service:'||NEW.app_id::text||':%')) THEN
    RAISE EXCEPTION 'invalid_value: application subject unavailable' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(NEW.actions) action WHERE action !~ '^(read|query|create|patch|delete|history|schema|command:[a-z][a-z0-9_.-]{0,127})$') THEN
    RAISE EXCEPTION 'invalid_value: unsupported application action' USING ERRCODE='22023';
  END IF;
  IF NEW.parent_grant_id IS NOT NULL THEN
    SELECT * INTO parent FROM application_access_grants WHERE id=NEW.parent_grant_id FOR SHARE;
    IF NOT FOUND OR parent.app_id<>NEW.app_id OR parent.workspace_id<>NEW.workspace_id OR parent.id=NEW.id
      OR parent.resource_origin<>NEW.resource_origin OR parent.resource_type<>NEW.resource_type THEN
      RAISE EXCEPTION 'invalid_value: parent grant unavailable' USING ERRCODE='22023';
    END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status='revoked' AND NEW.status<>'revoked' THEN RAISE EXCEPTION 'grant_revoked' USING ERRCODE='22023'; END IF;
    IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.app_id<>OLD.app_id
      OR NEW.principal_user_id<>OLD.principal_user_id OR NEW.principal_kind<>OLD.principal_kind
      OR NEW.resource_origin<>OLD.resource_origin OR NEW.resource_type<>OLD.resource_type
      OR NEW.parent_grant_id IS DISTINCT FROM OLD.parent_grant_id OR NEW.issued_by_user_id<>OLD.issued_by_user_id THEN
      RAISE EXCEPTION 'invalid_value: immutable grant binding' USING ERRCODE='22023';
    END IF;
    NEW.version:=OLD.version+1;NEW.updated_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION application_grant_guard() FROM PUBLIC;
CREATE TRIGGER application_grant_guard BEFORE INSERT OR UPDATE ON application_access_grants FOR EACH ROW EXECUTE FUNCTION application_grant_guard();

ALTER TABLE application_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_client_read ON application_clients FOR SELECT USING(application_governance_allows(workspace_id)
  OR EXISTS(SELECT 1 FROM application_access_grants g WHERE g.app_id=application_clients.id
    AND g.principal_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND g.status='active'
    AND g.starts_at<=now() AND (g.expires_at IS NULL OR g.expires_at>now())));
CREATE POLICY application_client_govern ON application_clients FOR ALL
  USING(application_governance_allows(workspace_id)) WITH CHECK(application_governance_allows(workspace_id));
CREATE POLICY application_grant_read ON application_access_grants FOR SELECT
  USING(application_governance_allows(workspace_id) OR principal_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
CREATE POLICY application_grant_govern ON application_access_grants FOR ALL USING(application_governance_allows(workspace_id))
  WITH CHECK(application_governance_allows(workspace_id) AND (status IN('suspended','revoked') OR application_runtime_qualified(workspace_id,'application_data')));

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON application_clients,application_access_grants TO app_user;
  END IF;
END $$;
COMMIT;
