BEGIN;

-- Explicit ingest routing target for a connector instance (2026-07 exposed-connector ingestion,
-- docs/plans/exposed-connector-ingestion.md). When set, the Pipeline C pollers route this
-- instance's episodes to THIS workspace instead of the owner's personal workspace. This is the
-- seam that lets a *personal* connector exposed to (and enabled for ingestion from) a team
-- workspace feed that workspace's brain, instead of silently landing in the owner's personal
-- brain — the mis-routing the pre-2026-07 "personal source on a team page" showed.
--
-- NULL preserves legacy routing (resolveInstanceWorkspaceId): workspace-scoped instances still
-- resolve to workspace_id; user-scoped instances with a NULL target still fall back to the
-- owner's owned-personal workspace. Existing enabled instances therefore route exactly as
-- before — no backfill required. ON DELETE SET NULL: if the target workspace is deleted, the
-- instance reverts to the fallback rather than orphaning a dangling id.
ALTER TABLE public.connector_instance
  ADD COLUMN ingest_workspace_id uuid
    REFERENCES public.workspaces(id) ON DELETE SET NULL;

COMMIT;
