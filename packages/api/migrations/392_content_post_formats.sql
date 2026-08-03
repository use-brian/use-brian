BEGIN;

-- Platform-shaped composition data is planning state, not provider state.
-- Keep it on the open draft row so OSS and hosted restore the same editor.
ALTER TABLE content_planning_drafts
  ADD COLUMN IF NOT EXISTS post_format text NOT NULL DEFAULT 'post',
  ADD COLUMN IF NOT EXISTS format_data jsonb NOT NULL DEFAULT '{}'::jsonb;

-- LinkedIn was added to the planning registry after the original table
-- constraint was created. Keep the persistence boundary aligned with the
-- platform union so LinkedIn posts and article-link drafts can be saved.
ALTER TABLE content_planning_drafts
  DROP CONSTRAINT IF EXISTS content_planning_drafts_platform_check,
  ADD CONSTRAINT content_planning_drafts_platform_check
  CHECK (platform IN ('instagram', 'threads', 'twitter', 'xhs', 'linkedin'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'content_planning_drafts_post_format_check'
       AND conrelid = 'content_planning_drafts'::regclass
  ) THEN
    ALTER TABLE content_planning_drafts
      ADD CONSTRAINT content_planning_drafts_post_format_check
      CHECK (post_format IN ('post', 'thread', 'article'));
  END IF;
END
$$;

COMMIT;
