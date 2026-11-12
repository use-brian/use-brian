-- [COMP:api/home-apps-store] Match the canonical owner/system and app-user roles.
-- Preserve registry, state, grants and ACLs; connection settings confer no bypass.
BEGIN;

ALTER TABLE workspace_home_apps NO FORCE ROW LEVEL SECURITY;
ALTER TABLE home_app_state NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS home_apps_system_bypass ON workspace_home_apps;
DROP POLICY IF EXISTS home_app_state_system_bypass ON home_app_state;

-- Guard before the membership subquery: its own legacy policies also read
-- the actor GUC, so casting NULL safely only inside that subquery is too late.
ALTER POLICY home_apps_workspace_member ON workspace_home_apps
  USING (CASE WHEN NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    THEN false
    ELSE workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  END);
ALTER POLICY home_app_state_workspace_member ON home_app_state
  USING (CASE WHEN NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    THEN false
    ELSE workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  END);

COMMIT;
