-- Per-connection opt-in: when this custom endpoint fails, serve the turn from
-- the workspace's ordinary Brian model instead of failing it.
--
-- Default FALSE preserves the strict contract every existing workspace agreed
-- to (docs/architecture/platform/byo-llm-key.md -> "Endpoint failure
-- fallback"): turning it on sends workspace content to a platform provider the
-- admin did not originally select, and bills the fallback turn as ordinary
-- platform usage. Both are consent decisions, so they belong to the admin who
-- owns the connection, not to a default.

BEGIN;

ALTER TABLE public.workspace_custom_llm_endpoints
  ADD COLUMN fallback_to_default_on_failure boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspace_custom_llm_endpoints.fallback_to_default_on_failure IS
  'Admin opt-in: a failed turn on this endpoint is retried on the platform model resolved for the turn tier. Announced to the user and billed as platform usage.';

COMMIT;
