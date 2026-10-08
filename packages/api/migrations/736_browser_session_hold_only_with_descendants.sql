-- [COMP:sandbox/session-source] Hold browser-session descendants only when they exist.
-- Spec: docs/architecture/engine/computer-use.md -> "Canonical originating web-session evidence".
-- Migration 692 ran the shared descendant hold on every session delete and
-- browser-source version change. That hold advances the workspace access-policy
-- revision unconditionally, so every ordinary chat deletion invalidated in-flight
-- creation admission receipts and migration plans. The hold is unchanged; it now
-- runs only when the session is an actual browser_session derivation source.
BEGIN;

CREATE OR REPLACE FUNCTION invalidate_browser_session_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.browser_source_version IS DISTINCT FROM OLD.browser_source_version THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
    AND EXISTS(SELECT 1 FROM scope_derivation_sources s
                WHERE s.workspace_id=OLD.workspace_id AND s.source_kind='browser_session' AND s.source_id=OLD.id) THEN
   PERFORM hold_scope_descendants(OLD.workspace_id,'browser_session',OLD.id);
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION invalidate_browser_session_scope() FROM PUBLIC;

COMMIT;
