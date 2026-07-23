BEGIN;

ALTER TABLE public.connector_instance
  DROP CONSTRAINT IF EXISTS connector_instance_credentials_type_check;

ALTER TABLE public.connector_instance
  ADD CONSTRAINT connector_instance_credentials_type_check
  CHECK (credentials_type = ANY (ARRAY[
    'none'::text,
    'oauth'::text,
    'bearer'::text,
    'custom_header'::text,
    'gcs'::text,
    's3'::text,
    'imap'::text,
    'local'::text
  ]));

COMMIT;
