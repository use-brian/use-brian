-- Allow 'gcs' as a connector_instance.credentials_type discriminator.
--
-- Bring-your-own GCS storage stores a customer service-account key in the
-- encrypted `credentials` blob with discriminator type 'gcs'. The existing
-- CHECK constraint (in both the open 280_oss_connectors baseline and the
-- hosted overlay baseline) only permits oauth/bearer/custom_header/none, so a
-- 'gcs' write would violate it. Extend the allow-list.
--
-- See docs/plans/byo-google-storage.md and
-- docs/architecture/features/files.md.

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
    'gcs'::text
  ]));

COMMIT;
