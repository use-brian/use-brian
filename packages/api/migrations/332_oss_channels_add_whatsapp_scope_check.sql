-- Keep this catalog update in its own transaction for PGLite. Hosted is a
-- guarded no-op because the closed overlay owns the channel tables.
BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'channels_whatsapp_bot_send_scope_check'
         AND conrelid = 'public.channels'::regclass
     ) THEN
    ALTER TABLE public.channels
      ADD CONSTRAINT channels_whatsapp_bot_send_scope_check
      CHECK (whatsapp_bot_send_scope IS NULL OR whatsapp_bot_send_scope = ANY (ARRAY['dm'::text, 'dm_and_groups'::text]));
  END IF;
END
$$;

COMMIT;
