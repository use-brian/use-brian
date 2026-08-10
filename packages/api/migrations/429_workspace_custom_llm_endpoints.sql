-- Workspace-scoped OpenAI-compatible endpoint profiles for self-hosted OSS.

BEGIN;

CREATE TABLE public.workspace_custom_llm_endpoints (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    base_url text NOT NULL CHECK (char_length(base_url) BETWEEN 8 AND 2048),
    api_key_encrypted bytea,
    model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 200),
    context_window integer NOT NULL CHECK (context_window BETWEEN 1024 AND 4000000),
    max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 262144),
    supports_tools boolean NOT NULL DEFAULT false,
    verified_at timestamp with time zone NOT NULL,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workspace_custom_llm_endpoints_workspace_name_key
    ON public.workspace_custom_llm_endpoints (workspace_id, lower(name));

CREATE UNIQUE INDEX workspace_custom_llm_endpoints_one_default
    ON public.workspace_custom_llm_endpoints (workspace_id)
    WHERE is_default;

CREATE INDEX idx_workspace_custom_llm_endpoints_workspace
    ON public.workspace_custom_llm_endpoints (workspace_id);

ALTER TABLE public.workspace_custom_llm_endpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_custom_llm_endpoints_select
    ON public.workspace_custom_llm_endpoints FOR SELECT
    USING (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ));

CREATE POLICY workspace_custom_llm_endpoints_insert
    ON public.workspace_custom_llm_endpoints FOR INSERT
    WITH CHECK (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ));

CREATE POLICY workspace_custom_llm_endpoints_update
    ON public.workspace_custom_llm_endpoints FOR UPDATE
    USING (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ))
    WITH CHECK (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ));

CREATE POLICY workspace_custom_llm_endpoints_delete
    ON public.workspace_custom_llm_endpoints FOR DELETE
    USING (workspace_id IN (
      SELECT workspace_members.workspace_id FROM public.workspace_members
       WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
    ));

COMMIT;
