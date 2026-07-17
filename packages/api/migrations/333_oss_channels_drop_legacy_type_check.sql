-- Drop only the legacy OSS check that predates the email channel. The final
-- replacement is a separate transaction in migration 334 for PGLite safety.
BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'channels_channel_type_check'
         AND conrelid = 'public.channels'::regclass
         AND pg_get_constraintdef(oid) NOT LIKE '%''email''::text%'
     ) THEN
    ALTER TABLE public.channels DROP CONSTRAINT channels_channel_type_check;
  END IF;
END
$$;

COMMIT;
