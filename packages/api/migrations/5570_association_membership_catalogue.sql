-- Versioned website content. No mutation of existing memberships or prices.
-- [COMP:crm/membership-catalogue]
BEGIN;
CREATE TABLE association_membership_catalogues (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_version INTEGER NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
  draft JSONB,
  published_revision INTEGER NOT NULL DEFAULT 0 CHECK (published_revision >= 0),
  observations JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE association_membership_catalogue_revisions (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  document JSONB NOT NULL,
  actor JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, revision)
);
ALTER TABLE association_membership_catalogues ENABLE ROW LEVEL SECURITY;
ALTER TABLE association_membership_catalogue_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_catalogue_workspace ON association_membership_catalogues
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
CREATE POLICY membership_catalogue_revision_workspace ON association_membership_catalogue_revisions
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
COMMIT;
