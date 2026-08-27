-- Local COGS ledger used by the standalone/open composition.
--
-- Hosted keeps its billing-aware `usage_tracking` table in the closed overlay.
-- This shared open migration also runs during a hosted bootstrap, so the table
-- deliberately has a different name and remains unused there. Standalone
-- metering must not import or emulate credits, plans, daily billing aggregates,
-- or hosted source constraints.
--
-- Internal system-pool writers/readers only. There is no end-user table route,
-- so (like channel_event_dedup) it needs no RLS policy. Workspace/user/
-- assistant deletion cascades match the hosted usage ledger. `session_id` is
-- TEXT because workflow iterations use `workflow_run_<uuid>`, not a sessions FK.

BEGIN;

CREATE TABLE IF NOT EXISTS public.oss_usage_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assistant_id UUID NOT NULL REFERENCES public.assistants(id) ON DELETE CASCADE,
  session_id TEXT,
  model TEXT NOT NULL,
  model_tier TEXT,
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  actual_cost_usd NUMERIC(18,10) NOT NULL CHECK (actual_cost_usd >= 0),
  source TEXT NOT NULL,
  user_message_id TEXT,
  trigger_key TEXT,
  provider_key_source TEXT CHECK (provider_key_source IN ('user', 'platform')),
  audio_seconds NUMERIC CHECK (audio_seconds IS NULL OR audio_seconds >= 0),
  source_episode_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.oss_usage_tracking IS
  'Local COGS ledger used by standalone. No credits, plan state, or hosted billing side effects.';
COMMENT ON COLUMN public.oss_usage_tracking.session_id IS
  'Arbitrary execution session key, including workflow_run_<uuid> goal iterations.';

CREATE INDEX IF NOT EXISTS oss_usage_tracking_session_cost_idx
  ON public.oss_usage_tracking (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS oss_usage_tracking_workspace_time_idx
  ON public.oss_usage_tracking (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS oss_usage_tracking_assistant_time_idx
  ON public.oss_usage_tracking (workspace_id, assistant_id, created_at DESC);

COMMIT;
