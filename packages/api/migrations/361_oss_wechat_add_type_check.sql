-- Re-add the OSS channel-type check with 'wechat' admitted (WeChat iLink bot
-- channel — docs/architecture/channels/wechat.md). The hosted counterpart is
-- migration 363 (overlay). Separate transaction from the 360 drop for PGLite
-- safety (mirrors 350 for the msteams addition).
BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'channels_channel_type_check'
         AND conrelid = 'public.channels'::regclass
     ) THEN
    ALTER TABLE public.channels
      ADD CONSTRAINT channels_channel_type_check
      CHECK (channel_type = ANY (ARRAY['telegram'::text, 'slack'::text, 'whatsapp'::text, 'discord'::text, 'email'::text, 'msteams'::text, 'wechat'::text]));
  END IF;
END
$$;

COMMIT;
