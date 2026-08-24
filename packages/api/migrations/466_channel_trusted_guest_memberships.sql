-- Trusted Telegram allowlist members.
--
-- An isolated channel shadow is normally not a workspace member. The explicit
-- per-integration full-access opt-in promotes an exact numeric Telegram id to a
-- normal workspace principal without borrowing the owner's identity. These
-- two tables distinguish membership created by that channel grant from a
-- pre-existing human-managed membership, so revocation can remove only rows
-- the channel created.

BEGIN;

CREATE TABLE channel_trusted_memberships (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members (workspace_id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE channel_trusted_access_grants (
  integration_id uuid NOT NULL REFERENCES channel_integrations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  provider_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, provider, provider_user_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES channel_trusted_memberships (workspace_id, user_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_channel_trusted_access_grants_membership
  ON channel_trusted_access_grants (workspace_id, user_id);

-- A grant disappearing means its channel configuration no longer authorizes
-- this principal (or the integration itself was deleted). Remove the generated
-- workspace membership only after the final channel grant disappears. A
-- promoted admin is retained and detached from channel ownership.
CREATE OR REPLACE FUNCTION cleanup_channel_trusted_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed_member boolean := false;
BEGIN
  -- If the marker itself is already disappearing (for example because an
  -- operator removed the workspace member directly), its FK cascade owns this
  -- delete. Do not recurse into deleting the same workspace_members row.
  IF NOT EXISTS (
    SELECT 1
      FROM channel_trusted_memberships
     WHERE workspace_id = OLD.workspace_id
       AND user_id = OLD.user_id
  ) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM channel_trusted_access_grants
     WHERE workspace_id = OLD.workspace_id
       AND user_id = OLD.user_id
  ) THEN
    RETURN OLD;
  END IF;

  DELETE FROM channel_trusted_memberships
   WHERE workspace_id = OLD.workspace_id
     AND user_id = OLD.user_id;

  DELETE FROM workspace_members
   WHERE workspace_id = OLD.workspace_id
     AND user_id = OLD.user_id
     AND role = 'member';
  removed_member := FOUND;

  IF removed_member THEN
    DELETE FROM assistant_members
     WHERE user_id = OLD.user_id
       AND assistant_id IN (
         SELECT id FROM assistants WHERE workspace_id = OLD.workspace_id
       )
       AND role <> 'owner';

    DELETE FROM teamspace_members tm
     USING teamspaces t
     WHERE t.id = tm.teamspace_id
       AND t.workspace_id = OLD.workspace_id
       AND tm.user_id = OLD.user_id;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER cleanup_channel_trusted_membership_after_grant
AFTER DELETE ON channel_trusted_access_grants
FOR EACH ROW EXECUTE FUNCTION cleanup_channel_trusted_membership();

COMMIT;
