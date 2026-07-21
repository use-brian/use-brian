-- Drop the pre-msteams OSS channel-type check so migration 350 can re-add it
-- with 'msteams' admitted (Microsoft Teams BYO channel —
-- docs/architecture/channels/msteams.md). Drop and add are split across two
-- transactions for PGLite safety, mirroring the 333 → 334 email addition.
BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'channels_channel_type_check'
         AND conrelid = 'public.channels'::regclass
         AND pg_get_constraintdef(oid) NOT LIKE '%''msteams''::text%'
     ) THEN
    ALTER TABLE public.channels DROP CONSTRAINT channels_channel_type_check;
  END IF;
END
$$;

COMMIT;
