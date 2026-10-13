-- 755_session_message_bookkeeping_not_semantic.sql  (OPEN table -> use-brian/packages/api/migrations/)
--
-- A channel delivery stamp stopped holding a conversation's derivations.
--
-- On channel lanes the transcript row is written before the send and the
-- channel-native id is stamped onto it afterwards (`setSessionMessageChannelId`,
-- src/db/sessions.ts). 609's generic `advance_canonical_scope_version` ignores
-- only counters and embedding bookkeeping, so that stamp advanced the message's
-- scope_version, and `invalidate_conversation_scope_descendants` then held every
-- derivation of the message (the reply derived from it, memories saved in the
-- turn). The same applied to `scope_held` itself: holding a message advanced its
-- version and re-ran the (already transitive) descendant hold.
--
-- Versioning: for session_message only, `channel_message_id` and `scope_held`
-- join the ignored bookkeeping. Content, role, sender, attachments, labels and
-- every other column still advance the version and hold descendants. Because a
-- hold no longer advances the version, a direct (top-level) hold of a message
-- still propagates through the explicit depth-1 clause, the same shape as 631,
-- 635, 643 and 752. Other kinds keep 609's projection unchanged.
--
-- No repair: a message whose version was advanced by a stamp has no
-- release path that this migration could use without inventing one; see
-- docs/architecture/context-engine/scoped-context.md ->
-- "Bookkeeping is not a source change".

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

CREATE OR REPLACE FUNCTION invalidate_conversation_scope_descendants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id);
    END IF;
  ELSIF NEW.scope_version IS DISTINCT FROM OLD.scope_version
    OR (TG_ARGV[0]='session_message' AND NOT OLD.scope_held AND NEW.scope_held AND pg_trigger_depth()=1) THEN
    PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION invalidate_conversation_scope_descendants() FROM PUBLIC;

COMMIT;
