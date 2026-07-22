-- Drop the pre-wechat OSS channel-type check so migration 361 can re-add it
-- with 'wechat' admitted (WeChat iLink bot channel —
-- docs/architecture/channels/wechat.md). Drop and add are split across two
-- transactions for PGLite safety, mirroring the 349 → 350 msteams addition.
BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'channels_channel_type_check'
         AND conrelid = 'public.channels'::regclass
         AND pg_get_constraintdef(oid) NOT LIKE '%''wechat''::text%'
     ) THEN
    ALTER TABLE public.channels DROP CONSTRAINT channels_channel_type_check;
  END IF;
END
$$;

COMMIT;
