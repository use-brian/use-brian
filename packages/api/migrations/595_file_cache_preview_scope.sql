BEGIN;

ALTER TABLE file_cache ADD COLUMN scope_held boolean NOT NULL DEFAULT false;

-- Shared rows keep explicit user visibility. Restrictive policies also bind
-- the old session-owner policy so it cannot bypass current membership.
CREATE POLICY file_cache_shared_read ON file_cache FOR SELECT USING (user_id IS NULL);
CREATE POLICY file_cache_read_floor ON file_cache AS RESTRICTIVE FOR SELECT
  USING (expires_at > now() AND NOT scope_held
    AND (user_id IS NULL OR user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
    AND member_operation_scope_allows(workspace_id,sensitivity,compartments,false));
CREATE POLICY file_cache_execution_visibility ON file_cache AS RESTRICTIVE FOR ALL
  USING (agent_visibility_allows(workspace_id,user_id,assistant_id))
  WITH CHECK (agent_visibility_allows(workspace_id,user_id,assistant_id));
CREATE POLICY file_cache_insert_floor ON file_cache AS RESTRICTIVE FOR INSERT
  WITH CHECK (member_operation_scope_allows(workspace_id,sensitivity,compartments,true)
    AND agent_mutation_scope_allows(compartments));
CREATE POLICY file_cache_update_floor ON file_cache AS RESTRICTIVE FOR UPDATE
  USING (member_operation_scope_allows(workspace_id,sensitivity,compartments,true)
    AND agent_mutation_scope_allows(compartments))
  WITH CHECK (member_operation_scope_allows(workspace_id,sensitivity,compartments,true)
    AND agent_mutation_scope_allows(compartments));
CREATE POLICY file_cache_delete_floor ON file_cache AS RESTRICTIVE FOR DELETE
  USING (member_operation_scope_allows(workspace_id,sensitivity,compartments,true)
    AND agent_mutation_scope_allows(compartments));

COMMIT;
