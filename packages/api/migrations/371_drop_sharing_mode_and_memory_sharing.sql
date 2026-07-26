-- 371_drop_sharing_mode_and_memory_sharing.sql
--
-- Network-feature teardown (docs/plans/network-feature-teardown.md).
--
-- 1. `assistants.sharing_mode` (off/private/public) is vestigial: no UI could
--    set it, so every assistant sat at the default 'off', and its only readers
--    (the /api/discover directory, /api/handles/search, and the sharing-gated
--    POST /api/connections/follow) were dark. Those endpoints are removed in the
--    same change; the A2A follow graph (assistant_connections) is untouched and
--    stays load-bearing for askAssistant/listConnectedAssistants.
--
-- 2. `workspace_memory_sharing` (created historically as `team_memory_sharing`)
--    is a remnant of the retired sharing_rules/sharing_circles memory model,
--    superseded by assistant_modes.memory_categories. Its only application-layer
--    reference was the workspace-flush cascade list; it was never read or written
--    at runtime. Dropped together with the flush-list entry.
--
-- Dropping the column also drops its dependent CHECK constraint
-- (assistants_sharing_mode_check). Dropping the table also drops its PK, unique
-- key, FK to workspaces, and RLS policy.

BEGIN;

ALTER TABLE public.assistants DROP COLUMN IF EXISTS sharing_mode;

DROP TABLE IF EXISTS public.workspace_memory_sharing;

COMMIT;
