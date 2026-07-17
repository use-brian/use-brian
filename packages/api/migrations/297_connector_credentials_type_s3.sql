-- Allow 's3' as a connector_instance.credentials_type discriminator.
--
-- Bring-your-own S3-compatible storage stores a customer access-key/secret-key
-- pair in the encrypted `credentials` blob with discriminator type 's3' (the
-- sibling of 'gcs', added in 285_connector_credentials_type_gcs.sql). The
-- existing CHECK constraint only permits none/oauth/bearer/custom_header/gcs,
-- so an 's3' write would violate it. Extend the allow-list.
--
-- See docs/plans/byo-s3-storage.md and docs/architecture/features/files.md.

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
    's3'::text
  ]));

COMMIT;
