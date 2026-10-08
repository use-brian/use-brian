-- Original source proof is distinct from the frozen permission ceiling.
BEGIN;
ALTER TABLE sandbox_tasks ADD COLUMN source_authority jsonb;
ALTER TABLE sandbox_tasks ADD CONSTRAINT sandbox_task_source_authority_object
  CHECK (source_authority IS NULL OR jsonb_typeof(source_authority) = 'object');
COMMIT;
