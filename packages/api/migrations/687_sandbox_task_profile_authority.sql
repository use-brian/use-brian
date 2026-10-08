-- Retain original profile classification across resume, capture and reaping.
-- Legacy rows intentionally remain null: current classification cannot prove their origin.
BEGIN;
ALTER TABLE sandbox_tasks ADD COLUMN profile_authority jsonb;
ALTER TABLE sandbox_tasks ADD CONSTRAINT sandbox_task_profile_authority_object
  CHECK (profile_authority IS NULL OR jsonb_typeof(profile_authority) = 'object');
COMMIT;
