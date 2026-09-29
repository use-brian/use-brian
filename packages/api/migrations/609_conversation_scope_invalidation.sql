-- Conversation rows can be intermediate nodes in the derivation graph. Holding
-- a source updates all its descendants together; recursively invalidating from
-- a BEFORE trigger can update a sibling that the outer command also updates
-- (PostgreSQL: "tuple to be updated was already modified"). Keep version stamps
-- in BEFORE, but invalidate conversation descendants AFTER the command's rows
-- have been updated. Existing holding predicates then skip already-held rows.
BEGIN;

CREATE OR REPLACE FUNCTION advance_canonical_scope_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ignored text[]=ARRAY['scope_version','updated_at','embedding','embedding_model_id','content_hash','embedding_failed_at','embedding_failure_reason','embedding_updated_at','search_vector','recall_count','useful_recall_count','last_recalled_at','query_hashes','recall_days','centrality','centrality_computed_at','last_checkpoint_at','extraction_locked'];
BEGIN
  IF TG_OP='DELETE' THEN
    IF TG_ARGV[0] NOT IN ('session_message','feedback_event')
      AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id);
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW)-ignored) IS DISTINCT FROM (to_jsonb(OLD)-ignored) THEN
    NEW.scope_version=OLD.scope_version+1;
    IF TG_ARGV[0] NOT IN ('session_message','feedback_event') THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id);
    END IF;
  ELSE NEW.scope_version=OLD.scope_version;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION invalidate_conversation_scope_descendants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id);
    END IF;
  ELSIF NEW.scope_version IS DISTINCT FROM OLD.scope_version THEN
    PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION invalidate_conversation_scope_descendants() FROM PUBLIC;

CREATE TRIGGER invalidate_conversation_scope_descendants
  AFTER UPDATE OR DELETE ON session_messages
  FOR EACH ROW EXECUTE FUNCTION invalidate_conversation_scope_descendants('session_message');
CREATE TRIGGER invalidate_conversation_scope_descendants
  AFTER UPDATE OR DELETE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION invalidate_conversation_scope_descendants('feedback_event');

COMMIT;
