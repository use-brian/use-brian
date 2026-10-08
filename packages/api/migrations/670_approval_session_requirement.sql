BEGIN;
-- [COMP:api/pending-approvals-store]
-- Nullable source FKs must not turn protected approvals into independent cards.
ALTER TABLE pending_approvals ADD COLUMN source_session_required boolean NOT NULL DEFAULT false;
UPDATE pending_approvals SET source_session_required = true
 WHERE blocking_session_id IS NOT NULL
    OR kind IN ('tool_invocation', 'question', 'browser_skill_send');

CREATE FUNCTION retain_approval_session_requirement() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.source_session_required := NEW.source_session_required
    OR NEW.blocking_session_id IS NOT NULL
    OR NEW.kind IN ('tool_invocation', 'question');
  IF TG_OP = 'UPDATE' THEN
    NEW.source_session_required := NEW.source_session_required OR OLD.source_session_required;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION retain_approval_session_requirement() FROM PUBLIC;
CREATE TRIGGER pending_approval_retain_session_requirement
  BEFORE INSERT OR UPDATE ON pending_approvals
  FOR EACH ROW EXECUTE FUNCTION retain_approval_session_requirement();
COMMIT;
