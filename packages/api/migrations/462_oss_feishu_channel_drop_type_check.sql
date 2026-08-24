-- Drop the pre-Feishu OSS channel-type check so migration 463 can re-add it
-- with 'feishu' admitted (docs/architecture/channels/feishu.md). Drop and add
-- are split across two transactions for PGLite safety.
BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'channels_channel_type_check'
         AND conrelid = 'public.channels'::regclass
         AND pg_get_constraintdef(oid) NOT LIKE '%''feishu''::text%'
     ) THEN
    ALTER TABLE public.channels DROP CONSTRAINT channels_channel_type_check;
  END IF;
END
$$;

COMMIT;
