-- Versioned website content collections (people, partners, settings, news,
-- home pages). One keyed store for every collection; each collection keeps its
-- own draft version, immutable revisions and per-site observations. Typed
-- content only: publication touches no plan, ticket, order or contact record.
-- [COMP:crm/site-content]
BEGIN;
CREATE TABLE association_site_content (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection TEXT NOT NULL CHECK (collection ~ '^[a-z][a-z0-9-]{0,39}$'),
  draft_version INTEGER NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
  draft JSONB,
  published_revision INTEGER NOT NULL DEFAULT 0 CHECK (published_revision >= 0),
  observations JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, collection)
);
CREATE TABLE association_site_content_revisions (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  document JSONB NOT NULL,
  actor JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, collection, revision),
  FOREIGN KEY (workspace_id, collection) REFERENCES association_site_content(workspace_id, collection) ON DELETE CASCADE
);
ALTER TABLE association_site_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE association_site_content_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_content_workspace ON association_site_content
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
CREATE POLICY site_content_revision_workspace ON association_site_content_revisions
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')))
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid AND role IN ('owner','admin')));
COMMIT;
