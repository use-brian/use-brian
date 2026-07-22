-- Allow 'imap' as a connector_instance.credentials_type discriminator.
--
-- The Company Email (IMAP) connector stores the user's mailbox credential
-- (address + app password + resolved IMAP/SMTP endpoints) in the encrypted
-- `credentials` blob with discriminator type 'imap' (the sibling pattern of
-- 'gcs'/'s3', added in 285/297). The existing CHECK constraint only permits
-- none/oauth/bearer/custom_header/gcs/s3, so an 'imap' write would violate
-- it. Extend the allow-list.
--
-- See docs/architecture/integrations/mailbox-imap.md.

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
    'imap'::text
  ]));

COMMIT;
