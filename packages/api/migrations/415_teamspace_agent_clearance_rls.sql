-- Teamspace agent access — assistants are clearance principals, not members.
--
-- The 2026-08-07 incident: moving two workflow-anchored pages into a
-- non-default teamspace broke every agent surface (workflow page anchors,
-- brain-MCP page tools) with `page_anchor_not_found`. Root cause: agent
-- executions act as an incidental HUMAN account (the workspace owner via
-- billingPartyForAssistant / resolveWriteTarget), and migration 313's policy
-- gates teamspace pages purely on per-user `teamspace_members` rows — a
-- membership no assistant can hold, satisfied only if that owner account
-- happens to have been added to the teamspace.
--
-- The primitive fix: an assistant execution carries the ASSISTANT's clearance
-- as the `app.agent_clearance` GUC (set by `runWithAgentClearance` →
-- `applyRLSGucs`, packages/api/src/db/client.ts — set only by trusted server
-- code on agentic paths: the inter-assistant callee executor and brain-MCP
-- key calls; never on interactive chat, which stays scoped to the chatting
-- member). The policy gains a third leg: when that GUC is present, a
-- teamspace page is visible iff the teamspace's sensitivity is within the
-- agent's clearance. Membership remains the (unchanged) model for humans;
-- with the GUC unset the policy is byte-equivalent to migration 313's.
--
-- Spec: docs/architecture/features/teamspaces.md → "Agent access".
-- [COMP:api/teamspace-store]

BEGIN;

DROP POLICY saved_views_workspace_member ON public.saved_views;

CREATE POLICY saved_views_workspace_member ON public.saved_views
  USING (
    workspace_id IN (
      SELECT workspace_members.workspace_id
      FROM public.workspace_members
      WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid)
    AND (
      (teamspace_id IS NULL
        AND created_by = (current_setting('app.current_user_id'::text, true))::uuid)
      OR teamspace_id IN (
        SELECT tm.teamspace_id FROM public.teamspace_members tm
        WHERE tm.user_id = (current_setting('app.current_user_id'::text, true))::uuid)
      OR (
        NULLIF(current_setting('app.agent_clearance'::text, true), '') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.teamspaces t
          WHERE t.id = saved_views.teamspace_id
            AND public.sensitivity_rank(t.sensitivity)
                <= public.sensitivity_rank(current_setting('app.agent_clearance'::text, true))
        )
      )
    )
  );

COMMIT;
