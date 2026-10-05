BEGIN;

-- A workspace has one lifecycle. The account's default is routing state only.
ALTER TABLE users ADD COLUMN default_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
UPDATE users u SET default_workspace_id = w.id
FROM workspaces w WHERE w.owner_user_id = u.id AND w.is_personal;
DROP INDEX IF EXISTS workspaces_owner_personal_unique;
UPDATE workspaces SET is_personal = false WHERE is_personal;
COMMENT ON COLUMN workspaces.is_personal IS 'Deprecated compatibility column. No runtime semantics; all workspaces have the same lifecycle.';

-- Primaries belong to their workspace, including those created at signup.
UPDATE assistants SET owner_user_id = NULL WHERE kind = 'primary' AND owner_user_id IS NOT NULL;
DELETE FROM assistant_members am USING assistants a WHERE am.assistant_id = a.id AND a.kind = 'primary';

CREATE FUNCTION maintain_account_workspace_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET default_workspace_id = NEW.id
      WHERE id = NEW.owner_user_id AND default_workspace_id IS NULL;
  ELSIF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    UPDATE users SET default_workspace_id = NULL
      WHERE id = OLD.owner_user_id AND default_workspace_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_workspace_default
AFTER INSERT OR UPDATE OF owner_user_id ON workspaces
FOR EACH ROW EXECUTE FUNCTION maintain_account_workspace_default();

COMMIT;
