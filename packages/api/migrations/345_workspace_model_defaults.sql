-- 345_workspace_model_defaults.sql  (OPEN table)
--
-- Workspace per-class model defaults (docs/plans/model-registry.md §4.4,
-- docs/architecture/platform/model-registry.md): one row per
-- (workspace, curated class) naming EITHER a curated same-class registry
-- alias (a pin; billing-neutral by construction) OR a saved metered profile
-- (the §4.4 "profiles pickable as overrides" half — surfaced with default
-- prominence in the composer, never silently armed: the L8 estimate→confirm
-- still gates every metered spend). No row = follow the registry default.
-- `model_alias` references a model-registry row by alias (code-owned, no FK);
-- profile deletion drops the default row with it (back to registry default).

BEGIN;

CREATE TABLE workspace_model_defaults (
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model_class        TEXT NOT NULL CHECK (model_class IN ('standard-pro', 'max', 'research')),
  model_alias        TEXT,
  metered_profile_id UUID REFERENCES metered_model_profiles(id) ON DELETE CASCADE,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, model_class),
  CHECK ((model_alias IS NULL) <> (metered_profile_id IS NULL))
);

-- RLS: workspace-membership read/write (defaults are workspace settings;
-- the route layer restricts WRITES to owner/admin). NULL-safe two-arg
-- current_setting (unset GUC -> NULL -> zero rows on the system/unauth path).
ALTER TABLE workspace_model_defaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_model_defaults_workspace_member ON workspace_model_defaults
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
