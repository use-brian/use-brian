-- Re-add the OSS channel-type check with 'custom' admitted (bridge-driven
-- custom channel — docs/architecture/channels/custom-channel.md). The hosted
-- counterpart is migration 451 (overlay). Separate transaction from the 448
-- drop for PGLite safety (mirrors 361 for the wechat addition).
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
      CHECK (channel_type = ANY (ARRAY['telegram'::text, 'slack'::text, 'whatsapp'::text, 'discord'::text, 'email'::text, 'msteams'::text, 'wechat'::text, 'custom'::text]));
  END IF;
END
$$;

COMMIT;
