-- 385_workspace_home_apps.sql
-- Workspace Home-apps configuration (open table).
--
-- One JSONB column holding an ORDERED array of operator-app entries, 1-6 of
-- them, deciding which apps show on the Home app-bar strip. Two entry kinds
-- share the array (see `@use-brian/shared/home-apps`, the single vocabulary
-- both the API and app-web validate against):
--
--   'page' | 'tasks' | 'crm' | 'feed' | 'browsers' | 'chat'  — built-ins
--   'custom:<uuid>'                                          — a workspace_home_apps row
--
-- '[]' means UNSET and resolves to the built-in default ['page','chat'] — it
-- is not "an empty strip", which is not a state the product has. Unknown
-- entries are FILTERED ON READ rather than rejected: a newer server (or a
-- teammate on a newer client) may write a key this build has never heard of,
-- and a deleted custom app leaves a dangling `custom:<id>` behind. In both
-- cases the strip must simply not render it. Writes are strict — the route
-- schema and the store setter both reject an unknown key, because a save that
-- names an app the server does not know is a client bug, and silently dropping
-- it would show the admin a strip they did not choose.
--
-- ROLLOUT — this is a grandfather stamp, not a backfill of defaults. Every
-- EXISTING workspace is stamped with all six apps, so nobody logs in tomorrow
-- to find four of their apps gone: the config's arrival must be invisible until
-- an admin opts into changing it. Only workspaces created AFTER this migration
-- land on '[]' and therefore on the minimal ['page','chat'] default.
--
-- Reader is system-level + null-safe (a config lookup must never block the
-- shell from rendering); writer is admin/owner-gated inside the store setter
-- because the workspaces table carries no RLS.
--
-- See docs/architecture/features/home-apps.md and
-- docs/architecture/platform/workspaces.md → "Home apps".

BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS home_apps JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN workspaces.home_apps IS
  'Ordered Home app-bar config, 1-6 entries of ''page''|''tasks''|''crm''|''feed''|''browsers''|''chat''|''custom:<uuid>'' (migration 385). [] = unset, resolves to the built-in default [page, chat].';

-- D2 grandfather stamp: existing workspaces keep every app they can see today.
-- Guarded on '[]' so a re-run (or a workspace an admin has already configured
-- between the ALTER and this UPDATE) is never overwritten.
UPDATE workspaces
   SET home_apps = '["page","tasks","crm","feed","browsers","chat"]'::jsonb
 WHERE home_apps = '[]'::jsonb;

COMMIT;
