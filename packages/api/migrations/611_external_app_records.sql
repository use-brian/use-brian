BEGIN;
CREATE TABLE external_app_record_bindings (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), source_id text NOT NULL, external_id text NOT NULL,
 entity_id uuid NOT NULL REFERENCES entities(id), kind text NOT NULL CHECK(kind IN ('company','deal')),
 PRIMARY KEY(workspace_id,source_id,external_id)
);
CREATE TABLE external_app_record_versions (
 workspace_id uuid NOT NULL, source_id text NOT NULL, external_id text NOT NULL, version bigint NOT NULL CHECK(version>0),
 payload jsonb NOT NULL, actor_user_id uuid NOT NULL REFERENCES users(id), correlation_id text NOT NULL,
 user_id uuid, assistant_id uuid, sensitivity text NOT NULL,
 compartments text[] NOT NULL DEFAULT '{}', project_ids uuid[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,source_id,external_id,version),
 FOREIGN KEY(workspace_id,source_id,external_id) REFERENCES external_app_record_bindings
);
CREATE TABLE external_app_record_observations (
 workspace_id uuid NOT NULL, source_id text NOT NULL, external_id text NOT NULL, provider_version bigint NOT NULL CHECK(provider_version>0),
 facts jsonb NOT NULL, actor_user_id uuid NOT NULL REFERENCES users(id), correlation_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,source_id,external_id,provider_version),
 FOREIGN KEY(workspace_id,source_id,external_id) REFERENCES external_app_record_bindings
);
CREATE TABLE external_app_access_versions (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), source_id text NOT NULL, external_id text NOT NULL, version bigint NOT NULL CHECK(version>0),
 payload jsonb NOT NULL, actor_user_id uuid NOT NULL REFERENCES users(id), correlation_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,source_id,external_id,version)
);
-- Evidence is append-only, including for owner-pool application code.
CREATE FUNCTION external_app_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'external_app_evidence_immutable'; END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON external_app_record_versions FOR EACH ROW EXECUTE FUNCTION external_app_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON external_app_record_observations FOR EACH ROW EXECUTE FUNCTION external_app_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON external_app_access_versions FOR EACH ROW EXECUTE FUNCTION external_app_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON external_app_record_bindings FOR EACH ROW EXECUTE FUNCTION external_app_immutable();
-- No generic app-role policies: these protected records are accessible only via
-- the explicitly authorized service on the owner pool, never generic CRM SQL.
ALTER TABLE external_app_record_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_app_record_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_app_record_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_app_access_versions ENABLE ROW LEVEL SECURITY;
COMMIT;
