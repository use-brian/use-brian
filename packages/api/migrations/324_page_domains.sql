-- 324: BYO custom domains + page slugs for published pages.
--
-- page_domains: a workspace-owned hostname fronting one published root page.
-- page_slugs: domain-scoped pretty paths with rename history (old slugs 301
-- to the current one). Spec: docs/architecture/features/custom-domains.md.

BEGIN;

CREATE TABLE page_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  status text NOT NULL DEFAULT 'pending_dns',
  provider text NOT NULL DEFAULT 'manual',
  verification_error text,
  last_checked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT page_domains_status_check
    CHECK (status IN ('pending_dns', 'live', 'error')),
  CONSTRAINT page_domains_provider_check
    CHECK (provider IN ('manual', 'vercel')),
  CONSTRAINT page_domains_hostname_lower_check
    CHECK (hostname = lower(hostname))
);

CREATE UNIQUE INDEX page_domains_hostname_idx ON page_domains (hostname);
CREATE INDEX page_domains_workspace_idx ON page_domains (workspace_id);
CREATE INDEX page_domains_page_idx ON page_domains (page_id);

CREATE TRIGGER page_domains_set_updated_at BEFORE UPDATE ON page_domains
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE page_slugs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES page_domains(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,
  slug text NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT page_slugs_slug_shape_check
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 64)
);

-- One live path per slug, one current slug per page, per domain. Historical
-- rows (is_current = false) stay behind as 301 sources.
CREATE UNIQUE INDEX page_slugs_domain_slug_idx ON page_slugs (domain_id, slug);
CREATE UNIQUE INDEX page_slugs_domain_page_current_idx
  ON page_slugs (domain_id, page_id) WHERE is_current;

ALTER TABLE page_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_slugs ENABLE ROW LEVEL SECURITY;

-- Members manage domains/slugs; anonymous site resolution reads system-side
-- via bare query() (same containment as page_grants link-token resolution).
-- The saved_views subquery inherits the teamspace tightening from 313.
CREATE POLICY page_domains_workspace_member ON page_domains
  USING (
    workspace_id IN (
      SELECT workspace_members.workspace_id
      FROM workspace_members
      WHERE workspace_members.user_id =
        (current_setting('app.current_user_id', true))::uuid
    )
  );

CREATE POLICY page_slugs_workspace_member ON page_slugs
  USING (
    domain_id IN (
      SELECT pd.id
      FROM page_domains pd
      JOIN workspace_members wm ON wm.workspace_id = pd.workspace_id
      WHERE wm.user_id = (current_setting('app.current_user_id', true))::uuid
    )
  );

COMMIT;
