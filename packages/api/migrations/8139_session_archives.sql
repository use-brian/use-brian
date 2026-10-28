-- [COMP:api/sessions-list] Per-viewer chat organization, independent of session lifecycle.
BEGIN;
CREATE TABLE session_archives (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);
CREATE INDEX session_archives_session ON session_archives(session_id);
ALTER TABLE session_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_archives FORCE ROW LEVEL SECURITY;
CREATE POLICY session_archives_own ON session_archives
  USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
COMMIT;
