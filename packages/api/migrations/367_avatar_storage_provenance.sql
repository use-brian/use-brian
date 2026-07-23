BEGIN;

ALTER TABLE public.users
  ADD COLUMN avatar_storage_workspace_id uuid,
  ADD COLUMN avatar_storage_uri text;

COMMIT;
