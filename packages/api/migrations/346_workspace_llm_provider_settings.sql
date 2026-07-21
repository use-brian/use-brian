-- 346_workspace_llm_provider_settings.sql
--
-- Reconcile the BYO Gemini key table onto EXISTING (baseline-skipped) databases.
--
-- `workspace_llm_provider_settings` is defined in the `000_open_schema_v1.sql`
-- squash baseline, but no incremental migration ever created it. Any database
-- that was baselined against `000` (marked applied WITHOUT executing, because
-- its schema predated the squash) never got the table: local dev DBs and
-- production alike. Fresh DBs execute `000` and have it; every long-lived DB
-- does not, so `GET /api/workspaces/:id/llm-keys` 500s with
-- `relation "workspace_llm_provider_settings" does not exist` and the workspace
-- settings "Gemini API key" block shows "Couldn't load the key status."
--
-- This migration forward-fixes those DBs. It is IDEMPOTENT: on a fresh DB the
-- table already exists (from `000`), so `CREATE TABLE IF NOT EXISTS` /
-- `CREATE INDEX IF NOT EXISTS` no-op and the policy DROP/CREATE simply recreates
-- identical policies. DDL mirrors the `000` definition exactly (same names).

BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_llm_provider_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider text DEFAULT 'gemini'::text NOT NULL,
    api_key_encrypted bytea NOT NULL,
    is_byok boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_llm_provider_settings_pkey PRIMARY KEY (id),
    CONSTRAINT workspace_llm_provider_settings_workspace_id_provider_key UNIQUE (workspace_id, provider),
    CONSTRAINT workspace_llm_provider_settings_provider_check CHECK ((provider = 'gemini'::text)),
    CONSTRAINT workspace_llm_provider_settings_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_llm_provider_settings_workspace
    ON public.workspace_llm_provider_settings USING btree (workspace_id);

ALTER TABLE public.workspace_llm_provider_settings ENABLE ROW LEVEL SECURITY;

-- Workspace-member scoped RLS (route layer narrows writes to owner/admin).
-- DROP-then-CREATE because Postgres has no CREATE POLICY IF NOT EXISTS.
DROP POLICY IF EXISTS workspace_llm_provider_settings_select ON public.workspace_llm_provider_settings;
CREATE POLICY workspace_llm_provider_settings_select ON public.workspace_llm_provider_settings
    FOR SELECT USING ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

DROP POLICY IF EXISTS workspace_llm_provider_settings_insert ON public.workspace_llm_provider_settings;
CREATE POLICY workspace_llm_provider_settings_insert ON public.workspace_llm_provider_settings
    FOR INSERT WITH CHECK ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

DROP POLICY IF EXISTS workspace_llm_provider_settings_update ON public.workspace_llm_provider_settings;
CREATE POLICY workspace_llm_provider_settings_update ON public.workspace_llm_provider_settings
    FOR UPDATE USING ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))))
    WITH CHECK ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

DROP POLICY IF EXISTS workspace_llm_provider_settings_delete ON public.workspace_llm_provider_settings;
CREATE POLICY workspace_llm_provider_settings_delete ON public.workspace_llm_provider_settings
    FOR DELETE USING ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

COMMIT;
