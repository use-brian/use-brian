BEGIN;

-- OSS Support Mode is deliberately installation-local. At most one capture
-- can be active, which keeps both the privacy boundary and storage cost easy
-- for a self-hosting operator to reason about.
CREATE TABLE support_diagnostic_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  include_content boolean NOT NULL DEFAULT false,
  pseudonym_salt bytea NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX support_diagnostic_single_capture
  ON support_diagnostic_sessions ((true));
CREATE INDEX support_diagnostic_sessions_owner
  ON support_diagnostic_sessions (user_id, workspace_id);

CREATE TABLE support_diagnostic_events (
  id bigserial PRIMARY KEY,
  support_session_id uuid NOT NULL
    REFERENCES support_diagnostic_sessions(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('debug', 'log', 'warn', 'error')),
  message text NOT NULL,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_diagnostic_events_capture_time
  ON support_diagnostic_events (support_session_id, created_at, id);

ALTER TABLE support_diagnostic_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_diagnostic_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY support_diagnostic_sessions_owner
  ON support_diagnostic_sessions
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY support_diagnostic_events_owner
  ON support_diagnostic_events
  USING (
    EXISTS (
      SELECT 1
      FROM support_diagnostic_sessions s
      WHERE s.id = support_diagnostic_events.support_session_id
        AND s.user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM support_diagnostic_sessions s
      WHERE s.id = support_diagnostic_events.support_session_id
        AND s.user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

COMMIT;
