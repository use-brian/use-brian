BEGIN;
-- [COMP:sandbox/profiles] One owning department, never inferred from credentials.
ALTER TABLE browser_profiles ADD COLUMN department_id uuid;
ALTER TABLE browser_profiles ADD CONSTRAINT browser_profiles_department_workspace_fk
 FOREIGN KEY (workspace_id, department_id) REFERENCES workspace_groups(workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX browser_profiles_department_idx ON browser_profiles(workspace_id, department_id);
COMMIT;
