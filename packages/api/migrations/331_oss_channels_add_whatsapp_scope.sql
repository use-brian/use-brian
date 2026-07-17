-- PGLite-safe forward convergence for migration 330. Migration 326 creates the
-- OSS channel tables first; older OSS databases may already have this column.
BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.channels'::regclass
         AND attname = 'whatsapp_bot_send_scope'
         AND NOT attisdropped
     ) THEN
    ALTER TABLE public.channels ADD COLUMN whatsapp_bot_send_scope text;
  END IF;
END
$$;

COMMIT;
