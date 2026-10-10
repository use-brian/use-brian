BEGIN;

-- One shared Brian conversation per Office file (office.md "Brian conversation
-- in the file"). The link is a child of the artifact root: it carries the
-- root's workspace, is read only where the caller can read the artifact
-- (migration-596 root binding), and disappears with the root.

CREATE TABLE office_artifact_sessions (
  artifact_id  uuid PRIMARY KEY REFERENCES office_artifacts(id) ON DELETE CASCADE,
  session_id   uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A link may only point at an office_thread session in the root's workspace.
CREATE FUNCTION validate_office_artifact_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM office_artifacts a WHERE a.id=NEW.artifact_id AND a.workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'Office conversation root mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=NEW.session_id
      AND s.channel_type='office_thread' AND s.workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'Office conversation must be an office_thread session in the same workspace' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER office_artifact_sessions_validate
  BEFORE INSERT OR UPDATE ON office_artifact_sessions
  FOR EACH ROW EXECUTE FUNCTION validate_office_artifact_session();

-- Removing the link removes the conversation (the session cascades its messages).
CREATE FUNCTION delete_office_artifact_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM sessions WHERE id=OLD.session_id AND channel_type='office_thread';
  RETURN NULL;
END $$;
CREATE TRIGGER office_artifact_sessions_cascade
  AFTER DELETE ON office_artifact_sessions
  FOR EACH ROW EXECUTE FUNCTION delete_office_artifact_session();

-- Purge keeps the root row (lifecycle 'purged'), so purge removes the link here.
CREATE FUNCTION purge_office_artifact_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM office_artifact_sessions WHERE artifact_id=NEW.id AND workspace_id=NEW.workspace_id;
  RETURN NEW;
END $$;
CREATE TRIGGER office_artifact_sessions_purge
  AFTER UPDATE OF lifecycle_state ON office_artifacts
  FOR EACH ROW WHEN (OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state AND NEW.lifecycle_state='purged')
  EXECUTE FUNCTION purge_office_artifact_session();

ALTER TABLE office_artifact_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY office_artifact_sessions_member ON office_artifact_sessions USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
  AND office_artifact_scope_allows(artifact_id,workspace_id,false)
);
CREATE POLICY office_scope_read ON office_artifact_sessions AS RESTRICTIVE FOR SELECT
  USING (office_artifact_scope_allows(artifact_id,workspace_id,false));
CREATE POLICY office_scope_insert ON office_artifact_sessions AS RESTRICTIVE FOR INSERT
  WITH CHECK (office_artifact_scope_allows(artifact_id,workspace_id,true));
CREATE POLICY office_scope_update ON office_artifact_sessions AS RESTRICTIVE FOR UPDATE
  USING (office_artifact_scope_allows(artifact_id,workspace_id,true))
  WITH CHECK (office_artifact_scope_allows(artifact_id,workspace_id,true));
CREATE POLICY office_scope_delete ON office_artifact_sessions AS RESTRICTIVE FOR DELETE
  USING (office_artifact_scope_allows(artifact_id,workspace_id,true));

COMMIT;
