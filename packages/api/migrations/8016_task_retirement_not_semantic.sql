-- Task supersession preserves the predecessor's historical body and scope.
-- Retiring that row must not hold an already-admitted task-list transcript,
-- which otherwise blocks the same turn immediately after a committed update.
-- Only an unchanged predecessor and an identically scoped live successor
-- qualify. All other source changes retain the existing transitive hold.
-- Previously held rows are not released by this migration.
BEGIN;

CREATE OR REPLACE FUNCTION advance_canonical_scope_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ignored text[]=ARRAY['scope_version','updated_at','embedding','embedding_model_id','content_hash','embedding_failed_at','embedding_failure_reason','embedding_updated_at','search_vector','recall_count','useful_recall_count','last_recalled_at','query_hashes','recall_days','centrality','centrality_computed_at','last_checkpoint_at','extraction_locked'];
BEGIN
  IF TG_ARGV[0]='session_message' THEN
    ignored:=ignored||ARRAY['channel_message_id','scope_held'];
  END IF;
  IF TG_OP='DELETE' THEN
    IF TG_ARGV[0] NOT IN ('session_message','feedback_event')
      AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id);
    END IF;
    RETURN OLD;
  END IF;
  IF TG_ARGV[0]='task' THEN
    IF OLD.valid_to IS NULL AND OLD.superseded_by IS NULL
      AND NEW.valid_to IS NOT NULL AND NEW.superseded_by IS NOT NULL
      AND NOT OLD.scope_held AND OLD.retracted_at IS NULL
      AND (to_jsonb(NEW)-ignored-ARRAY['valid_to','superseded_by'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ignored-ARRAY['valid_to','superseded_by'])
      AND EXISTS(
        SELECT 1 FROM tasks successor
         WHERE successor.id=NEW.superseded_by AND successor.id<>OLD.id
           AND successor.valid_to IS NULL AND successor.retracted_at IS NULL
           AND NOT successor.scope_held
           AND NOT scope_review_state_held('task',successor.id)
           AND ROW(successor.workspace_id,successor.user_id,successor.assistant_id,
                   successor.sensitivity,successor.compartments,successor.project_ids)
             IS NOT DISTINCT FROM
               ROW(OLD.workspace_id,OLD.user_id,OLD.assistant_id,
                   OLD.sensitivity,OLD.compartments,OLD.project_ids)
         FOR SHARE
      ) THEN
      NEW.scope_version=OLD.scope_version;
      RETURN NEW;
    END IF;
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
REVOKE ALL ON FUNCTION advance_canonical_scope_version() FROM PUBLIC;

COMMIT;
