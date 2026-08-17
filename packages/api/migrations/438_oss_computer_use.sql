-- 438_oss_computer_use.sql
--
-- Computer Use is an OSS feature. Historical hosted migrations 315, 317, and
-- 322 created its persistence only in the closed overlay; standalone installs
-- therefore exposed the routes and UI but had no profiles, relay pairing,
-- durable tasks, session reuse, or standing grants. Fresh OSS databases create
-- the final profile-centric shape here. Hosted skips that block, then both
-- editions receive additive contract-convergence columns and encrypted browser
-- credentials.

BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.browser_profiles') IS NULL THEN

    CREATE TABLE public.browser_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
      owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      clearance text NOT NULL DEFAULT 'confidential'
        CHECK (clearance IN ('public', 'internal', 'confidential')),
      enabled_assistant_ids uuid[] NOT NULL DEFAULT '{}',
      assistant_routing_notes jsonb NOT NULL DEFAULT '{}',
      default_backend text NOT NULL DEFAULT 'cloud'
        CHECK (default_backend IN ('local', 'cloud')),
      local_control_mode text NOT NULL DEFAULT 'task_tabs'
        CHECK (local_control_mode IN ('task_tabs', 'full_browser')),
      proxy_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, name)
    );

    CREATE INDEX idx_browser_profiles_workspace
      ON public.browser_profiles (workspace_id);

    ALTER TABLE public.browser_profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY browser_profiles_workspace_member ON public.browser_profiles
      USING (workspace_id IN (
        SELECT wm.workspace_id FROM public.workspace_members wm
        WHERE wm.user_id = (current_setting('app.current_user_id', true))::uuid))
      WITH CHECK (workspace_id IN (
        SELECT wm.workspace_id FROM public.workspace_members wm
        WHERE wm.user_id = (current_setting('app.current_user_id', true))::uuid));

    CREATE TABLE public.browser_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
      profile_id uuid NOT NULL REFERENCES public.browser_profiles(id) ON DELETE CASCADE,
      site text NOT NULL CHECK (length(site) BETWEEN 1 AND 253),
      encrypted_bundle bytea NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dead')),
      captured_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (profile_id, site)
    );

    CREATE INDEX idx_browser_sessions_workspace
      ON public.browser_sessions (workspace_id);
    CREATE INDEX idx_browser_sessions_profile
      ON public.browser_sessions (profile_id);
    CREATE INDEX idx_browser_sessions_last_used
      ON public.browser_sessions (COALESCE(last_used_at, captured_at));

    ALTER TABLE public.browser_sessions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY browser_sessions_by_clearance ON public.browser_sessions
      USING (
        user_id = (current_setting('app.current_user_id', true))::uuid
        OR EXISTS (
          SELECT 1
          FROM public.browser_profiles bp
          JOIN public.workspace_members wm
            ON wm.workspace_id = bp.workspace_id
           AND wm.user_id = (current_setting('app.current_user_id', true))::uuid
          WHERE bp.id = browser_sessions.profile_id
            AND bp.clearance <> 'confidential'
            AND (CASE wm.clearance WHEN 'confidential' THEN 3 WHEN 'internal' THEN 2 ELSE 1 END)
                >= (CASE bp.clearance WHEN 'confidential' THEN 3 WHEN 'internal' THEN 2 ELSE 1 END)
        )
      );

    CREATE TABLE public.sandbox_tasks (
      task_id uuid PRIMARY KEY,
      sandbox_id text NOT NULL,
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
      session_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed')),
      profile_id uuid REFERENCES public.browser_profiles(id) ON DELETE SET NULL,
      injected_site text,
      browser_started_at timestamptz,
      authorized_budget_usd numeric(10, 4) NOT NULL DEFAULT 2,
      spent_usd numeric(12, 6) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_activity_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_sandbox_tasks_session_active
      ON public.sandbox_tasks (session_id)
      WHERE status IN ('running', 'paused');
    CREATE INDEX idx_sandbox_tasks_stale
      ON public.sandbox_tasks (last_activity_at)
      WHERE status IN ('running', 'paused');
    CREATE INDEX idx_sandbox_tasks_workspace
      ON public.sandbox_tasks (workspace_id, created_at DESC);

    CREATE TABLE public.browser_skill_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
      skill_id uuid NOT NULL REFERENCES public.browser_skills(id) ON DELETE CASCADE,
      profile_id uuid NOT NULL REFERENCES public.browser_profiles(id) ON DELETE CASCADE,
      granted_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      budget_usd numeric(10, 4),
      rate_per_hour integer,
      spent_usd numeric(12, 6) NOT NULL DEFAULT 0,
      window_started_at timestamptz,
      window_use_count integer NOT NULL DEFAULT 0,
      expires_at timestamptz,
      status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked', 'voided')),
      void_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    );

    CREATE UNIQUE INDEX idx_browser_skill_grants_active
      ON public.browser_skill_grants (workspace_id, skill_id, profile_id)
      WHERE status = 'active';
    CREATE INDEX idx_browser_skill_grants_profile
      ON public.browser_skill_grants (profile_id);

    ALTER TABLE public.browser_skill_grants ENABLE ROW LEVEL SECURITY;
    CREATE POLICY browser_skill_grants_workspace_member ON public.browser_skill_grants
      USING (workspace_id IN (
        SELECT wm.workspace_id FROM public.workspace_members wm
        WHERE wm.user_id = (current_setting('app.current_user_id', true))::uuid))
      WITH CHECK (workspace_id IN (
        SELECT wm.workspace_id FROM public.workspace_members wm
        WHERE wm.user_id = (current_setting('app.current_user_id', true))::uuid));
  END IF;
END $$;

-- Hosted already owns these tables through 315/317/322. Bring that historical
-- shape up to the current open TypeScript contracts without replacing data.
ALTER TABLE public.browser_profiles
  ADD COLUMN IF NOT EXISTS assistant_routing_notes jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS local_control_mode text NOT NULL DEFAULT 'task_tabs';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_profiles_local_control_mode_check'
      AND conrelid = 'public.browser_profiles'::regclass
  ) THEN
    ALTER TABLE public.browser_profiles
      ADD CONSTRAINT browser_profiles_local_control_mode_check
      CHECK (local_control_mode IN ('task_tabs', 'full_browser'));
  END IF;
END $$;

ALTER TABLE public.sandbox_tasks
  ADD COLUMN IF NOT EXISTS browser_started_at timestamptz;

CREATE TABLE IF NOT EXISTS public.browser_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.browser_profiles(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  site text NOT NULL CHECK (length(site) BETWEEN 1 AND 253),
  login_url text NOT NULL CHECK (login_url ~ '^https://'),
  account_label text,
  encrypted_secret bytea NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid')),
  last_used_at timestamptz,
  last_failure_code text CHECK (last_failure_code IS NULL OR last_failure_code IN (
    'auth_unavailable', 'cross_site_redirect', 'human_verification',
    'mfa_required', 'field_not_found', 'field_ambiguous', 'submit_not_found',
    'login_rejected', 'empty_session', 'backend_error'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, site)
);

CREATE INDEX IF NOT EXISTS idx_browser_credentials_workspace
  ON public.browser_credentials (workspace_id);
CREATE INDEX IF NOT EXISTS idx_browser_credentials_profile
  ON public.browser_credentials (profile_id);

ALTER TABLE public.browser_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS browser_credentials_owner ON public.browser_credentials;
CREATE POLICY browser_credentials_owner ON public.browser_credentials
  USING (owner_user_id = (current_setting('app.current_user_id', true))::uuid)
  WITH CHECK (owner_user_id = (current_setting('app.current_user_id', true))::uuid);

COMMIT;
