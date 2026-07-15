-- 326: AgentMail email channel — data model (Phase 1).
--
-- Two halves (spec: docs/architecture/integrations/agentmail.md):
--
-- (A) OSS-edition channel substrate. The `channels` / `channel_integrations` /
--     `channel_assistants` / `channel_user_cache` tables are owned by the
--     CLOSED overlay baseline in hosted, so the open baseline omits them and
--     the OSS edition had no BYO-channel storage at all (web chat only). The
--     email channel is open (decision D5), so — following the
--     280_oss_connectors.sql pattern — this block creates those tables for
--     OSS only, mirroring the overlay DDL, with 'email' admitted by the
--     channel-type CHECK from birth. Hosted no-ops here (guarded on the
--     app.migration_edition GUC AND to_regclass) and gets its CHECK extension
--     in the overlay's 327_channels_email_type.sql instead.
--
-- (B) Both editions: `email_domains` (BYO mail domains, decision D2) and the
--     inbox-address lookup index on channel_integrations (`bot_username`
--     holds the inbox address for channel_type='email'; the webhook resolves
--     inbound mail through it). Name-sort puts this file after
--     000_overlay_v1.sql on a fresh hosted bootstrap, so the overlay table
--     exists by the time the index runs.

BEGIN;

-- ── (A) OSS-only channel substrate ───────────────────────────

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NULL THEN

    -- Workspace-owned channel installs (mirror of the overlay DDL, plus
    -- 'email' in the type CHECK).
    CREATE TABLE public.channels (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      workspace_id uuid NOT NULL,
      channel_type text NOT NULL,
      clearance text DEFAULT 'internal'::text NOT NULL,
      enabled_capabilities text[] DEFAULT '{}'::text[] NOT NULL,
      status text DEFAULT 'active'::text NOT NULL,
      display_name text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT channels_pkey PRIMARY KEY (id),
      CONSTRAINT channels_channel_type_check CHECK (channel_type = ANY (ARRAY['telegram'::text, 'slack'::text, 'whatsapp'::text, 'discord'::text, 'email'::text])),
      CONSTRAINT channels_clearance_check CHECK (clearance = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text])),
      CONSTRAINT channels_enabled_capabilities_check CHECK (enabled_capabilities <@ ARRAY['chat'::text, 'broadcast'::text, 'ingest'::text]),
      CONSTRAINT channels_status_check CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text, 'invalid'::text])),
      CONSTRAINT channels_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_channels_workspace ON public.channels (workspace_id, channel_type);

    CREATE TRIGGER channels_set_updated_at BEFORE UPDATE ON public.channels
      FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

    -- Encrypted per-channel credentials (one row per channels install).
    CREATE TABLE public.channel_integrations (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      channel_type text NOT NULL,
      team_id text,
      team_name text,
      bot_user_id text,
      credentials bytea NOT NULL,
      status text DEFAULT 'active'::text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      last_event_at timestamp with time zone,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      connection_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      bot_username text,
      channel_id uuid NOT NULL,
      connector_instance_id uuid,
      CONSTRAINT channel_integrations_pkey PRIMARY KEY (id),
      CONSTRAINT channel_integrations_channel_id_key UNIQUE (channel_id),
      CONSTRAINT valid_ci_status CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text, 'invalid'::text])),
      CONSTRAINT channel_integrations_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE,
      CONSTRAINT channel_integrations_connector_instance_id_fkey FOREIGN KEY (connector_instance_id) REFERENCES public.connector_instance(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_channel_integrations_ci_link ON public.channel_integrations (connector_instance_id) WHERE (connector_instance_id IS NOT NULL);

    CREATE TRIGGER set_updated_at_channel_integrations BEFORE UPDATE ON public.channel_integrations
      FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

    -- Per-surface assistant routing.
    CREATE TABLE public.channel_assistants (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      channel_id uuid NOT NULL,
      assistant_id uuid NOT NULL,
      external_surface_id text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      model_alias text DEFAULT 'pro'::text NOT NULL,
      CONSTRAINT channel_assistants_pkey PRIMARY KEY (id),
      CONSTRAINT channel_assistants_model_alias_check CHECK (model_alias = ANY (ARRAY['standard'::text, 'pro'::text, 'max'::text])),
      CONSTRAINT channel_assistants_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE,
      CONSTRAINT channel_assistants_assistant_id_fkey FOREIGN KEY (assistant_id) REFERENCES public.assistants(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX idx_channel_assistants_default ON public.channel_assistants (channel_id) WHERE (external_surface_id IS NULL);
    CREATE UNIQUE INDEX idx_channel_assistants_surface ON public.channel_assistants (channel_id, external_surface_id) WHERE (external_surface_id IS NOT NULL);

    -- Assistant and channel must share a workspace (mirror of the overlay's
    -- guard trigger).
    CREATE OR REPLACE FUNCTION public.channel_assistants_workspace_match()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF (SELECT workspace_id FROM public.assistants WHERE id = NEW.assistant_id)
         <> (SELECT workspace_id FROM public.channels WHERE id = NEW.channel_id) THEN
        RAISE EXCEPTION 'channel_assistants: assistant and channel must share a workspace';
      END IF;
      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER channel_assistants_workspace_match_trg
      BEFORE INSERT OR UPDATE OF channel_id, assistant_id ON public.channel_assistants
      FOR EACH ROW EXECUTE FUNCTION public.channel_assistants_workspace_match();

    -- Channel-identity resolution cache (the integrations upsert invalidates
    -- it; identity healing reads it).
    CREATE TABLE public.channel_user_cache (
      provider text NOT NULL,
      provider_user_id text NOT NULL,
      email text,
      display_name text,
      user_id uuid NOT NULL,
      assistant_id uuid NOT NULL,
      cached_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT channel_user_cache_pkey PRIMARY KEY (provider, provider_user_id, assistant_id),
      CONSTRAINT channel_user_cache_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
      CONSTRAINT channel_user_cache_assistant_id_fkey FOREIGN KEY (assistant_id) REFERENCES public.assistants(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_cuc_assistant ON public.channel_user_cache (assistant_id);
    CREATE INDEX idx_cuc_user ON public.channel_user_cache (user_id);

    -- RLS mirrors the overlay: channels gate on workspace membership +
    -- clearance; the two dependents inherit through the channels policy.
    ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
    CREATE POLICY channels_workspace_member ON public.channels
      USING (EXISTS (
        SELECT 1 FROM public.workspace_members wm
        WHERE wm.workspace_id = channels.workspace_id
          AND wm.user_id = (current_setting('app.current_user_id'::text, true))::uuid
          AND public.sensitivity_rank(channels.clearance) <= public.sensitivity_rank(wm.clearance)
      ));

    ALTER TABLE public.channel_integrations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY channel_integrations_channel_member ON public.channel_integrations
      USING (channel_id IN (SELECT channels.id FROM public.channels));

    ALTER TABLE public.channel_assistants ENABLE ROW LEVEL SECURITY;
    CREATE POLICY channel_assistants_workspace_member ON public.channel_assistants
      USING (channel_id IN (SELECT channels.id FROM public.channels));

  END IF;
END
$$;

-- ── (B) Both editions ────────────────────────────────────────

-- BYO mail domains (decision D2). One row per workspace-owned domain;
-- `records` is the DNS instruction payload (MX/SPF/DKIM/DMARC rows) shown in
-- the UI, refreshed on every provider verify. `provider_status` keeps the raw
-- vendor enum behind the normalized `status`.
CREATE TABLE email_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain text NOT NULL,
  provider_domain_id text,
  status text NOT NULL DEFAULT 'pending',
  provider_status text,
  records jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_domains_status_check
    CHECK (status IN ('pending', 'verified', 'failed')),
  CONSTRAINT email_domains_domain_lower_check
    CHECK (domain = lower(domain))
);

CREATE UNIQUE INDEX email_domains_domain_idx ON email_domains (domain);
CREATE INDEX email_domains_workspace_idx ON email_domains (workspace_id);

CREATE TRIGGER email_domains_set_updated_at BEFORE UPDATE ON email_domains
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

ALTER TABLE email_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_domains_workspace_member ON email_domains
  USING (
    workspace_id IN (
      SELECT workspace_members.workspace_id
      FROM workspace_members
      WHERE workspace_members.user_id =
        (current_setting('app.current_user_id', true))::uuid
    )
  );

-- Inbound-webhook routing: for channel_type='email', bot_username holds the
-- inbox address (the AgentMail inbox_id IS the address) and
-- getByBotUsernameSystem resolves deliveries through this index.
CREATE INDEX idx_channel_integrations_email_address
  ON channel_integrations (bot_username) WHERE channel_type = 'email';

COMMIT;
