BEGIN;
-- [COMP:api/session-title-jobs] System queue metadata is never transcript authority.
CREATE TABLE session_title_jobs (
 session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 user_message_id uuid,
 auth_claims jsonb NOT NULL,
 authoring_authority jsonb NOT NULL,
 generation bigint NOT NULL DEFAULT 1,
 claimed_generation bigint,
 lease_token uuid,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 available_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_title_jobs_pending ON session_title_jobs(available_at,created_at) WHERE status IN ('pending','processing');
ALTER TABLE session_title_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON session_title_jobs FROM PUBLIC;
-- Fresh OSS installs can migrate before the application role is provisioned.
-- RLS has no policies, so later broad bootstrap grants cannot expose rows.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON session_title_jobs FROM app_user;
 END IF;
END $$;
COMMIT;
