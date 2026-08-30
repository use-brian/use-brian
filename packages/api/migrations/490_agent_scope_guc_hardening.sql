-- Keep transaction-local agent-scope GUCs safe across pooled connections.
-- Spec: docs/architecture/platform/database-schema.md

BEGIN;

-- A custom GUC that has no session value can revert from SET LOCAL to ''. The
-- cast itself must therefore normalize empty text; a neighboring boolean guard
-- is insufficient because PostgreSQL may reorder policy expressions.
CREATE OR REPLACE FUNCTION public.context_scope_allows_current_principal(
  p_workspace_id uuid,
  p_sensitivity text,
  p_compartments text[],
  p_project_ids uuid[]
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  member_clearance text;
  team_grant text[];
  agent_clearance text := NULLIF(current_setting('app.agent_clearance', true), '');
  agent_teams jsonb;
  agent_projects jsonb;
BEGIN
  SELECT wm.clearance INTO member_clearance
    FROM public.workspace_members wm
   WHERE wm.workspace_id = p_workspace_id
     AND wm.user_id = current_setting('app.current_user_id', true)::uuid;
  IF member_clearance IS NULL THEN RETURN false; END IF;

  IF agent_clearance IS NULL THEN
    IF public.sensitivity_rank(p_sensitivity) > public.sensitivity_rank(member_clearance) THEN
      RETURN false;
    END IF;
    team_grant := public.effective_member_team_compartments(
      current_setting('app.current_user_id', true)::uuid,
      p_workspace_id
    );
    RETURN team_grant IS NULL OR COALESCE(p_compartments, '{}') <@ team_grant;
  END IF;

  IF public.sensitivity_rank(p_sensitivity) > public.sensitivity_rank(agent_clearance) THEN
    RETURN false;
  END IF;
  IF NULLIF(current_setting('app.agent_compartments', true), '') IS NOT NULL THEN
    agent_teams := NULLIF(current_setting('app.agent_compartments', true), '')::jsonb;
    IF agent_teams <> 'null'::jsonb AND NOT (
      SELECT COALESCE(bool_and(agent_teams ? value), true)
        FROM unnest(COALESCE(p_compartments, '{}')) AS u(value)
    ) THEN RETURN false; END IF;
  END IF;
  IF NULLIF(current_setting('app.agent_project_ids', true), '') IS NOT NULL THEN
    agent_projects := NULLIF(current_setting('app.agent_project_ids', true), '')::jsonb;
    IF agent_projects <> 'null'::jsonb AND NOT (
      SELECT COALESCE(bool_and(agent_projects ? value::text), true)
        FROM unnest(COALESCE(p_project_ids, '{}')) AS u(value)
    ) THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

-- Page access composes the human Team grant with the trusted assistant GUCs.
-- A clearance-only legacy agent wrap can still enter unlinked Teamspaces, but
-- linked Teamspaces fail closed until both clearance and compartments exist.
DROP POLICY saved_views_workspace_member ON public.saved_views;
CREATE POLICY saved_views_workspace_member ON public.saved_views
  USING (
    workspace_id IN (
      SELECT wm.workspace_id
        FROM public.workspace_members wm
       WHERE wm.user_id = (current_setting('app.current_user_id', true))::uuid
    )
    AND (
      (teamspace_id IS NULL
        AND created_by = (current_setting('app.current_user_id', true))::uuid)
      OR EXISTS (
        SELECT 1
          FROM public.teamspaces t
         WHERE t.id = saved_views.teamspace_id
           AND (
             (
               t.workspace_group_id IS NULL
               AND (
                 (
                   NULLIF(current_setting('app.agent_clearance', true), '') IS NULL
                   AND EXISTS (
                     SELECT 1 FROM public.teamspace_members tm
                      WHERE tm.teamspace_id = t.id
                        AND tm.user_id = (current_setting('app.current_user_id', true))::uuid
                   )
                 )
                 OR (
                   NULLIF(current_setting('app.agent_clearance', true), '') IS NOT NULL
                   AND public.sensitivity_rank(t.sensitivity)
                       <= public.sensitivity_rank(current_setting('app.agent_clearance', true))
                 )
               )
             )
             OR (
               t.workspace_group_id IS NOT NULL
               AND EXISTS (
                 SELECT 1
                   FROM public.workspace_groups g
                  WHERE g.id = t.workspace_group_id
                    AND (
                      (
                        NULLIF(current_setting('app.agent_clearance', true), '') IS NULL
                        AND (
                        public.effective_member_team_compartments(
                          (current_setting('app.current_user_id', true))::uuid,
                          t.workspace_id
                        ) IS NULL
                        OR ARRAY[g.compartment_key]::text[] <@
                           public.effective_member_team_compartments(
                             (current_setting('app.current_user_id', true))::uuid,
                             t.workspace_id
                           )
                        )
                      )
                      OR (
                        NULLIF(current_setting('app.agent_clearance', true), '') IS NOT NULL
                        AND NULLIF(current_setting('app.agent_compartments', true), '') IS NOT NULL
                        AND public.sensitivity_rank(t.sensitivity)
                            <= public.sensitivity_rank(current_setting('app.agent_clearance', true))
                        AND (
                          NULLIF(current_setting('app.agent_compartments', true), '')::jsonb
                            = 'null'::jsonb
                          OR NULLIF(current_setting('app.agent_compartments', true), '')::jsonb
                            ? g.compartment_key
                        )
                      )
                    )
               )
             )
           )
      )
    )
    AND (
      NULLIF(current_setting('app.agent_clearance', true), '') IS NULL
      OR NULLIF(current_setting('app.agent_project_ids', true), '') IS NULL
      OR NULLIF(current_setting('app.agent_project_ids', true), '')::jsonb = 'null'::jsonb
      OR project_id IS NULL
      OR NULLIF(current_setting('app.agent_project_ids', true), '')::jsonb ? project_id::text
    )
  );

COMMIT;
