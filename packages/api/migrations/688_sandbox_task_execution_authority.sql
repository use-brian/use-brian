-- Retain the original acting-assistant ceiling; null does not prove an agent origin.
BEGIN;
ALTER TABLE sandbox_tasks ADD COLUMN execution_authority jsonb;
ALTER TABLE sandbox_tasks ADD CONSTRAINT sandbox_task_execution_authority_object
  CHECK (execution_authority IS NULL OR jsonb_typeof(execution_authority) = 'object');
COMMIT;
