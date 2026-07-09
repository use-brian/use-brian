-- Workspace-scoped tool policy for team-owned connectors.
--
-- allow/ask/block for a connector tool, keyed by WORKSPACE (not user). The
-- runtime resolves a team-owned (`scope='workspace'`) connector's tool policy
-- from here instead of the owner's per-user `mcp_tool_settings`, so any member
-- with sufficient clearance governs what the shared assistant may call.
-- Personal and personal-exposed (granted) connectors are unaffected — they keep
-- the per-user `mcp_tool_settings` path.
--
-- Spec: docs/plans/workspace-owned-connector-transfer.md §2C and
-- docs/architecture/integrations/mcp.md. [COMP:api/workspace-tool-policy-store]

BEGIN;

CREATE TABLE public.workspace_tool_policy (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    server_name text NOT NULL,
    tool_name text NOT NULL,
    policy text DEFAULT 'ask'::text NOT NULL,
    classification text,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_tool_policy_pkey PRIMARY KEY (id),
    CONSTRAINT workspace_tool_policy_unique UNIQUE (workspace_id, server_name, tool_name),
    CONSTRAINT workspace_tool_policy_policy_check
      CHECK (policy = ANY (ARRAY['allow'::text, 'ask'::text, 'block'::text])),
    CONSTRAINT workspace_tool_policy_classification_check
      CHECK ((classification IS NULL) OR (classification = ANY (ARRAY['read'::text, 'write'::text, 'destructive'::text, 'unknown'::text]))),
    CONSTRAINT workspace_tool_policy_workspace_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT workspace_tool_policy_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_workspace_tool_policy_lookup
  ON public.workspace_tool_policy (workspace_id, server_name, tool_name);

CREATE TRIGGER workspace_tool_policy_set_updated_at
  BEFORE UPDATE ON public.workspace_tool_policy
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.workspace_tool_policy ENABLE ROW LEVEL SECURITY;

-- Any member of the workspace may read/write the shared policy under RLS; the
-- finer `clearance >= connector.sensitivity` gate lives in the route (RLS
-- can't express it and is deliberately coarser, mirroring connector_instance
-- ci_access). The runtime read at tool-injection time is system-level (no
-- acting user), like mcp_tool_settings.
CREATE POLICY wtp_member ON public.workspace_tool_policy
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM public.workspace_members wm
    WHERE wm.user_id = (current_setting('app.current_user_id'::text, true))::uuid))
  WITH CHECK (workspace_id IN (
    SELECT wm.workspace_id FROM public.workspace_members wm
    WHERE wm.user_id = (current_setting('app.current_user_id'::text, true))::uuid));

COMMIT;
