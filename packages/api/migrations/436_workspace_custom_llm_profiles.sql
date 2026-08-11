-- Normalize each custom OpenAI-compatible provider into one reusable
-- connection, one or more verified model profiles, and per-Brian-tier
-- assignments. The existing endpoint relation is transformed in place so
-- every reader keeps targeting the same table throughout the migration.

BEGIN;

ALTER TABLE public.workspace_custom_llm_endpoints
  ADD CONSTRAINT workspace_custom_llm_endpoints_id_workspace_key
    UNIQUE (id, workspace_id);

CREATE TABLE public.workspace_custom_llm_profiles (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    endpoint_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 200),
    context_window integer NOT NULL CHECK (context_window BETWEEN 1024 AND 4000000),
    max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 262144),
    supports_tools boolean NOT NULL DEFAULT false,
    verified_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (id, workspace_id),
    FOREIGN KEY (endpoint_id, workspace_id)
      REFERENCES public.workspace_custom_llm_endpoints(id, workspace_id)
      ON DELETE CASCADE
);

-- Preserve the old row id as both the reusable connection id and the first
-- profile id. Existing custom:<uuid> selectors therefore keep resolving.
INSERT INTO public.workspace_custom_llm_profiles
  (id, workspace_id, endpoint_id, name, model_id, context_window,
   max_output_tokens, supports_tools, verified_at, created_at, updated_at)
SELECT id, workspace_id, id, name, model_id, context_window,
       max_output_tokens, supports_tools, verified_at, created_at, updated_at
  FROM public.workspace_custom_llm_endpoints;

CREATE TABLE public.workspace_custom_llm_tier_defaults (
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    tier text NOT NULL CHECK (tier IN ('standard', 'pro', 'max', 'research')),
    profile_id uuid NOT NULL,
    updated_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, tier),
    FOREIGN KEY (profile_id, workspace_id)
      REFERENCES public.workspace_custom_llm_profiles(id, workspace_id)
      ON DELETE CASCADE
);

-- The old global default applied to every user-facing tier. Preserve that
-- behavior explicitly; admins can now replace or clear each assignment.
INSERT INTO public.workspace_custom_llm_tier_defaults
  (workspace_id, tier, profile_id)
SELECT endpoint.workspace_id, tiers.tier, endpoint.id
  FROM public.workspace_custom_llm_endpoints endpoint
 CROSS JOIN (VALUES ('standard'), ('pro'), ('max'), ('research')) AS tiers(tier)
 WHERE endpoint.is_default;

DROP INDEX public.workspace_custom_llm_endpoints_one_default;

ALTER TABLE public.workspace_custom_llm_endpoints
  DROP COLUMN model_id,
  DROP COLUMN context_window,
  DROP COLUMN max_output_tokens,
  DROP COLUMN supports_tools,
  DROP COLUMN verified_at,
  DROP COLUMN is_default;

CREATE UNIQUE INDEX workspace_custom_llm_profiles_endpoint_name_key
    ON public.workspace_custom_llm_profiles (endpoint_id, lower(name));
CREATE INDEX idx_workspace_custom_llm_profiles_workspace
    ON public.workspace_custom_llm_profiles (workspace_id);
CREATE INDEX idx_workspace_custom_llm_profiles_endpoint
    ON public.workspace_custom_llm_profiles (endpoint_id);

ALTER TABLE public.workspace_custom_llm_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_custom_llm_tier_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_custom_llm_profiles_member
    ON public.workspace_custom_llm_profiles
    USING (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ))
    WITH CHECK (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ));

CREATE POLICY workspace_custom_llm_tier_defaults_member
    ON public.workspace_custom_llm_tier_defaults
    USING (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ))
    WITH CHECK (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ));

COMMIT;
