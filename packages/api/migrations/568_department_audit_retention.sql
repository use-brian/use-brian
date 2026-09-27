BEGIN;

CREATE FUNCTION protect_workspace_access_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    -- The workspace deletion contract owns retention of the entire workspace.
    IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
  ELSIF TG_OP='UPDATE' THEN
    -- Honor the actor FK's ON DELETE SET NULL, but no other rewrite.
    IF OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.actor_user_id)
      AND (to_jsonb(NEW)-'actor_user_id')=(to_jsonb(OLD)-'actor_user_id') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'access_audit_append_only';
END;
$$;

CREATE TRIGGER workspace_access_events_immutable BEFORE UPDATE OR DELETE
  ON workspace_access_events FOR EACH ROW EXECUTE FUNCTION protect_workspace_access_event();
CREATE TRIGGER workspace_access_events_no_truncate BEFORE TRUNCATE
  ON workspace_access_events FOR EACH STATEMENT EXECUTE FUNCTION protect_workspace_access_event();

COMMIT;
