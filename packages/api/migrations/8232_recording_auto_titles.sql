BEGIN;

ALTER TABLE recordings
  ADD COLUMN generated_title text,
  ADD COLUMN auto_title_attempts integer NOT NULL DEFAULT 0 CHECK (auto_title_attempts BETWEEN 0 AND 3),
  ADD COLUMN auto_title_retry_at timestamptz;
ALTER TABLE workspace_files ADD COLUMN generated_title text;
CREATE INDEX recordings_auto_title_pending ON recordings (auto_title_retry_at NULLS FIRST, created_at DESC)
  WHERE generated_title IS NULL AND status='processed' AND NOT truncated AND auto_title_attempts<3;

-- Only derived display metadata is maintenance. Original title, content and
-- authority changes retain all existing invalidation/versioning behavior.
CREATE OR REPLACE FUNCTION entity_scope_semantic_row(r jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT r-ARRAY['scope_version','updated_at','embedding','embedding_model_id','content_hash',
    'embedding_failed_at','embedding_failure_reason','embedding_updated_at','search_vector',
    'recall_count','useful_recall_count','last_recalled_at','query_hashes','recall_days',
    'centrality','centrality_computed_at','last_checkpoint_at','extraction_locked',
    'generated_title','auto_title_attempts','auto_title_retry_at']
$$;
REVOKE ALL ON FUNCTION entity_scope_semantic_row(jsonb) FROM PUBLIC;

CREATE FUNCTION clear_generated_recording_title() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF media_semantic_row(to_jsonb(NEW)) IS DISTINCT FROM media_semantic_row(to_jsonb(OLD)) THEN
    NEW.generated_title:=NULL;
    NEW.auto_title_attempts:=3;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION clear_generated_file_title() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF entity_scope_semantic_row(to_jsonb(NEW)) IS DISTINCT FROM entity_scope_semantic_row(to_jsonb(OLD)) THEN
    NEW.generated_title:=NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clear_generated_recording_title(),clear_generated_file_title() FROM PUBLIC;
CREATE TRIGGER a_clear_generated_title BEFORE UPDATE ON recordings
  FOR EACH ROW EXECUTE FUNCTION clear_generated_recording_title();
CREATE TRIGGER a_clear_generated_title BEFORE UPDATE ON workspace_files
  FOR EACH ROW EXECUTE FUNCTION clear_generated_file_title();

-- Lock exact segment metadata without requiring UPDATE authority on transcript
-- content. The generic entity reader does not admit transcript_segment. This
-- narrow facade admits the current recording first and never returns text.
CREATE FUNCTION read_recording_title_segment(w uuid,r uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE recording jsonb; segment jsonb; key text;
BEGIN
  recording:=read_entity_derivation_source(w,'recording',r);
  IF recording IS NULL OR NOT EXISTS(SELECT 1 FROM transcript_segments
    WHERE workspace_id=w AND recording_id=r AND id=i) THEN RETURN NULL; END IF;
  segment:=read_scope_source(w,'transcript_segment',i);
  IF segment IS NULL OR segment->>'held' IS DISTINCT FROM 'false'
    OR segment->>'validTo' IS NOT NULL OR segment->>'retractedAt' IS NOT NULL
    OR scope_review_state_held('transcript_segment',i) OR NOT media_parent_visible('transcript_segment',i)
    THEN RETURN NULL; END IF;
  FOREACH key IN ARRAY ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds'] LOOP
    IF segment->key IS DISTINCT FROM recording->key THEN RETURN NULL; END IF;
  END LOOP;
  RETURN segment;
END $$;
REVOKE ALL ON FUNCTION read_recording_title_segment(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    GRANT EXECUTE ON FUNCTION read_recording_title_segment(uuid,uuid,uuid) TO app_user;
  END IF;
END $$;

COMMIT;
