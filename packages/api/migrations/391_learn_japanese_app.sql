-- 391_learn_japanese_app.sql
--
-- First-party Learn Japanese installation. One workspace may own one
-- Japanese Teacher app assistant. OAuth reconnection returns that row instead
-- of creating duplicate assistants or splitting conversation history.

BEGIN;

ALTER TABLE assistants
  DROP CONSTRAINT IF EXISTS assistant_app_type_values;

ALTER TABLE assistants
  ADD CONSTRAINT assistant_app_type_values
  CHECK (app_type IS NULL OR app_type IN ('distribution', 'learn-japanese'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistants_learn_japanese_workspace
  ON assistants (workspace_id)
  WHERE app_type = 'learn-japanese';

COMMIT;
