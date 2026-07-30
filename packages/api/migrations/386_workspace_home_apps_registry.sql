-- 386_workspace_home_apps_registry.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- Custom Home apps: workspace-installed artifact bundles that render full-page
-- in a Home operator-app slot, inside a sandboxed opaque-origin iframe, and
-- reach the workspace brain only through a scoped bridge token.
-- Spec: docs/architecture/features/home-apps.md → "Custom apps".
-- Plan: docs/plans/custom-home-apps.md §5.
--
-- WHY A REGISTRY TABLE AND NOT JUST FILES. `workspaces.home_apps` (migration
-- 385) already accepts `custom:<uuid>` entries, but an entry is only a
-- pointer: the app's identity, its last validated manifest, where it syncs
-- from, WHAT IT IS ALLOWED TO REACH, and whether an admin has consented to
-- that are all row state. Putting any of it in the bundle would mean the app
-- describes its own permissions, which is not a permission model.
--
-- THE GRANT IS THE REVIEW. Registering, importing, or authoring an app is
-- ordinary member-visible work. An app only RENDERS after a workspace
-- owner/admin grants the scopes its manifest requests (`granted_scopes`, plus
-- an optional `max_clearance` cap mirroring brain keys). If a later sync
-- brings a manifest whose requested scopes exceed the grant, the app drops to
-- `needs_consent` and leaves the strip until re-granted — scope drift VOIDS
-- the grant, the same rule browser-skill grants use. `granted_scopes IS NULL`
-- means never consented, which is why the status default is `needs_consent`
-- rather than `active`.
--
-- NEVER A STORED PAT. GitHub-kind apps point at `connector_instance_id`, so
-- the sync worker resolves credentials through the connector's existing
-- encrypted store. Revoking the connector revokes the sync.
--
-- Bundle FILES are not in this table — they live in workspace file storage
-- under the reserved `/apps/<appId>/` prefix, excluded from brain retrieval
-- exactly like the `/doc/%` media prefix.
--
-- Filenames are globally unique across BOTH migration dirs (one shared
-- _migrations table). Next free number after this is 387.

BEGIN;

-- ── workspace_home_apps ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspace_home_apps (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- 'github'    — synced from a repo (the KB source model)
  -- 'assistant' — authored in-app by the workspace assistant; no repo fields
  kind                   text NOT NULL CHECK (kind IN ('github', 'assistant')),

  -- Display identity, denormalized from the last validated manifest so the
  -- app-bar can render a strip entry without parsing a bundle on every read.
  name                   text NOT NULL,
  description            text,
  icon                   text,

  -- github kind only
  repo                   text,
  branch                 text NOT NULL DEFAULT 'main',
  root_path              text NOT NULL DEFAULT '',
  connector_instance_id  uuid REFERENCES connector_instance(id) ON DELETE SET NULL,
  last_synced_sha        text,
  last_synced_at         timestamptz,
  sync_error             text,

  -- The last manifest that PASSED validation. The serving path trusts this,
  -- never the bundle on disk: a half-written sync must not be able to widen
  -- what the app may do.
  manifest               jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- What an admin actually consented to. NULL = never consented.
  granted_scopes         jsonb,
  granted_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at             timestamptz,
  -- Optional per-app clearance ceiling, mirroring brain keys' max_clearance.
  -- NULL = the workspace primary assistant's clearance governs.
  max_clearance          text CHECK (max_clearance IN ('public', 'internal', 'confidential')),

  status                 text NOT NULL DEFAULT 'needs_consent'
                           CHECK (status IN ('active', 'disabled', 'needs_consent')),

  -- Per-app daily bridge-call budget, transplanted from public chat links.
  -- 0 = unlimited. Reset-by-date is done in the same atomic UPDATE as the
  -- increment, so there is no window where a stale window_date lets a day's
  -- worth of calls through.
  daily_call_limit       integer NOT NULL DEFAULT 5000,
  daily_used             integer NOT NULL DEFAULT 0,
  daily_window_date      date,

  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- One row per (workspace, repo, root_path) for the github kind. Partial, so
-- assistant-authored apps (all NULL repo) are not collapsed into one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_home_apps_workspace_repo
  ON workspace_home_apps (workspace_id, repo, root_path)
  WHERE kind = 'github';

CREATE INDEX IF NOT EXISTS idx_home_apps_workspace_status
  ON workspace_home_apps (workspace_id, status);

-- The sync worker's claim scan: github apps with a repo, oldest sync first.
CREATE INDEX IF NOT EXISTS idx_home_apps_sync_due
  ON workspace_home_apps (last_synced_at NULLS FIRST)
  WHERE kind = 'github' AND status <> 'disabled';

COMMENT ON COLUMN workspace_home_apps.granted_scopes IS
  'Scopes an owner/admin consented to. NULL = never consented. A synced manifest requesting MORE than this drops the app to needs_consent (scope drift voids the grant).';
COMMENT ON COLUMN workspace_home_apps.connector_instance_id IS
  'Pointer to the GitHub connector whose encrypted credentials the sync uses. Never a stored PAT.';

-- ── home_app_state ──────────────────────────────────────────────────────────
-- Bridge KV. The app iframe is opaque-origin, so it has NO localStorage,
-- sessionStorage, IndexedDB, or cookies — that is the whole point of the
-- sandbox. Anything an app wants to remember comes back here, at one of two
-- scopes: workspace-wide (`user_id IS NULL`) or per viewer.

CREATE TABLE IF NOT EXISTS home_app_state (
  app_id       uuid NOT NULL REFERENCES workspace_home_apps(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- `UNIQUE (app_id, user_id)` does NOT constrain the workspace-scoped row:
-- NULLs are distinct in a plain unique index, so two workspace rows could
-- coexist and the upsert would silently write a second one. Two partial
-- indexes state each case exactly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_home_app_state_user
  ON home_app_state (app_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_home_app_state_workspace
  ON home_app_state (app_id)
  WHERE user_id IS NULL;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Member READ; the grant + scope mutations are owner/admin-checked in the
-- store setter (the brain-keys pattern), because "who may consent" is a role
-- question the row predicate cannot express.

ALTER TABLE workspace_home_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_home_apps FORCE ROW LEVEL SECURITY;
ALTER TABLE home_app_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_app_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS home_apps_workspace_member ON workspace_home_apps;
CREATE POLICY home_apps_workspace_member ON workspace_home_apps
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ));

DROP POLICY IF EXISTS home_apps_system_bypass ON workspace_home_apps;
CREATE POLICY home_apps_system_bypass ON workspace_home_apps
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

DROP POLICY IF EXISTS home_app_state_workspace_member ON home_app_state;
CREATE POLICY home_app_state_workspace_member ON home_app_state
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ));

DROP POLICY IF EXISTS home_app_state_system_bypass ON home_app_state;
CREATE POLICY home_app_state_system_bypass ON home_app_state
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

COMMIT;
