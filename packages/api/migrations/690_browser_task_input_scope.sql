BEGIN;
-- [COMP:sandbox/input-scope]
-- Existing NULL means unknown input history, never proven General.
ALTER TABLE sandbox_tasks ADD COLUMN input_scope jsonb;
ALTER TABLE sandbox_tasks ADD CONSTRAINT sandbox_task_input_scope_object
  CHECK(input_scope IS NULL OR jsonb_typeof(input_scope)='object');
COMMIT;
