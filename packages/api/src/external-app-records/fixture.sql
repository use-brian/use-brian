-- Focused PostgreSQL fixture for real canonical CRM writers (not a mock store).
CREATE TABLE users(id uuid PRIMARY KEY, auth_version integer NOT NULL DEFAULT 0);
CREATE TABLE workspaces(id uuid PRIMARY KEY);
CREATE TABLE workspace_members(workspace_id uuid REFERENCES workspaces, user_id uuid REFERENCES users, role text NOT NULL, clearance text NOT NULL DEFAULT 'restricted', compartments text[], PRIMARY KEY(workspace_id,user_id));
CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid,clearance text);
CREATE TABLE auth_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES users,auth_version integer DEFAULT 0,last_seen_at timestamptz DEFAULT now(),expires_at timestamptz DEFAULT now()+interval '30 days',revoked_at timestamptz);
CREATE FUNCTION sensitivity_rank(text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT CASE $1 WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 WHEN 'restricted' THEN 3 END $$;
CREATE FUNCTION effective_member_team_compartments(uuid,uuid) RETURNS text[] LANGUAGE sql STABLE AS $$ SELECT CASE WHEN role IN ('owner','admin') THEN NULL ELSE compartments END FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 $$;
CREATE FUNCTION effective_member_read_compartments(uuid,uuid) RETURNS text[] LANGUAGE sql STABLE AS $$ SELECT effective_member_team_compartments($1,$2) $$;
CREATE TABLE entities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, display_name text NOT NULL, canonical_id text,
 sensitivity text NOT NULL DEFAULT 'internal', user_id uuid, assistant_id uuid, workspace_id uuid NOT NULL REFERENCES workspaces,
 created_by_user_id uuid NOT NULL REFERENCES users, created_by_assistant_id uuid, source_episode_id uuid, source_session_id uuid,
 source text NOT NULL, verified_by_user_id uuid, verified_at timestamptz, valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz,
 superseded_by uuid REFERENCES entities, retracted_at timestamptz, retracted_reason text, retracted_by uuid,
 attributes jsonb NOT NULL DEFAULT '{}', centrality double precision DEFAULT 0, centrality_computed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), aliases text[] NOT NULL DEFAULT '{}',
 compartments text[] NOT NULL DEFAULT '{}', project_ids uuid[] NOT NULL DEFAULT '{}', scope_held boolean NOT NULL DEFAULT false
);
