-- 413_workspace_brands.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- The brand primitive: branding positioning as a first-class workspace record.
-- Spec: docs/architecture/features/brand.md
-- Plan: docs/plans/brand-primitive.md §4 (schema) + D1 / D4 / D5.
--
-- WHY A TABLE AND NOT A KB CONVENTION. The consumers of this data are code —
-- the L1 digest builder, the future theme-token seed, the Office release gate,
-- the template compiler's font-licence check. Code must not parse markdown or
-- walk an entity graph to get a hex value, and a convention-schema drifts:
-- the palette repo's own markdown template and TypeScript type disagree today
-- about the logo variant table, the rights register, and typography licences
-- (plan §1 evidence 2). A typed column set is the fix.
--
-- TWO TABLES, ONE LIFECYCLE (D4, mirroring Office template admission). The
-- `draft` column is mutable and is where every assistant and Studio write
-- lands. Approving inserts an IMMUTABLE row into workspace_brand_versions and
-- points `active_version_id` at it, in one transaction. The next edit opens a
-- fresh draft; superseded versions are retained, never rewritten. This is what
-- makes "the approved brand" a thing a consumer can read without asking
-- whether someone is mid-edit — and what makes the approval gate non-vacuous:
-- assistant writes can only ever touch `draft`.
--
-- ONE DEFAULT BRAND PER WORKSPACE (D5). The schema is multi-brand shaped (an
-- agency workspace already holds two in the palette repo) but the v1 UX and
-- every v1 consumer read the default brand only; brand-context routing is
-- deferred. A partial unique index enforces at most one default.
--
-- Filenames are globally unique across BOTH migration dirs (one shared
-- _migrations table). Next free number after this is 415 (414 is the brand
-- capability backfill).

BEGIN;

-- ── workspace_brands ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspace_brands (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Stable handle used in file paths (`/brand/<slug>/…`) and in tool input,
  -- so a caller addresses a brand without carrying a uuid around.
  slug              text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name              text NOT NULL CHECK (length(btrim(name)) > 0),

  -- Exactly one default per workspace (partial unique index below). The L1
  -- digest and every v1 consumer read the default brand.
  is_default        boolean NOT NULL DEFAULT false,

  -- Derived convenience mirroring the row's real state, denormalized so a
  -- list view does not need the versions table:
  --   'draft'      — never approved (active_version_id IS NULL)
  --   'active'     — an approved version is live
  --   'superseded' — was active, then retired without a replacement
  -- The store maintains it inside the same transaction as the state change;
  -- `active_version_id` remains the authority.
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'active', 'superseded')),

  -- The live approved version. NULL until the first Approve. FK added after
  -- workspace_brand_versions exists (the two tables reference each other).
  active_version_id uuid,

  -- The mutable working copy. NULL when there is nothing in flight — i.e.
  -- the active version and the draft agree, so there is nothing to approve.
  draft             jsonb,

  sensitivity       text NOT NULL DEFAULT 'internal'
                      CHECK (sensitivity IN ('public', 'internal', 'confidential')),

  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_brands_slug
  ON workspace_brands (workspace_id, slug);

-- At most one default per workspace. Partial (not a plain UNIQUE on
-- (workspace_id, is_default)) because `false` must stay repeatable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_brands_one_default
  ON workspace_brands (workspace_id)
  WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_workspace_brands_workspace
  ON workspace_brands (workspace_id, updated_at DESC);

COMMENT ON COLUMN workspace_brands.draft IS
  'Mutable working copy of the brand record. The ONLY column assistant writes may touch; approval is a Studio action by an owner/admin.';
COMMENT ON COLUMN workspace_brands.active_version_id IS
  'The live approved version. Authority for "the active brand"; workspace_brands.status is a denormalized mirror.';

-- ── workspace_brand_versions ────────────────────────────────────────────────
-- Immutable. The store exposes no UPDATE path; a change is a new version.

CREATE TABLE IF NOT EXISTS workspace_brand_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES workspace_brands(id) ON DELETE CASCADE,
  -- Denormalized so RLS can gate this table on workspace membership without
  -- joining back through workspace_brands on every read.
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version     integer NOT NULL CHECK (version >= 1),
  record      jsonb NOT NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_versions_brand_version
  ON workspace_brand_versions (brand_id, version);

CREATE INDEX IF NOT EXISTS idx_brand_versions_brand_recent
  ON workspace_brand_versions (brand_id, version DESC);

ALTER TABLE workspace_brands
  ADD CONSTRAINT workspace_brands_active_version_fkey
  FOREIGN KEY (active_version_id)
  REFERENCES workspace_brand_versions(id)
  ON DELETE SET NULL;

COMMENT ON TABLE workspace_brand_versions IS
  'Immutable approved versions of a brand record. No UPDATE path exists in the store — superseding means inserting the next version.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Workspace-member read/write, plus the system-bypass escape the workers and
-- boot-time paths use (the files / KB pattern). Approval is additionally
-- owner/admin-gated in the route, because "who may approve" is a role
-- question a row predicate cannot express.

ALTER TABLE workspace_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_brands FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_brand_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_brand_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_brands_member ON workspace_brands;
CREATE POLICY workspace_brands_member ON workspace_brands
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ));

DROP POLICY IF EXISTS workspace_brands_system_bypass ON workspace_brands;
CREATE POLICY workspace_brands_system_bypass ON workspace_brands
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

DROP POLICY IF EXISTS brand_versions_member ON workspace_brand_versions;
CREATE POLICY brand_versions_member ON workspace_brand_versions
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ));

DROP POLICY IF EXISTS brand_versions_system_bypass ON workspace_brand_versions;
CREATE POLICY brand_versions_system_bypass ON workspace_brand_versions
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

COMMIT;
