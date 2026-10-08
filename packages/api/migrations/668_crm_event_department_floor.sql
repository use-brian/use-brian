BEGIN;

-- V2 CRM source-history member floor. One SQL grant adapter supports both
-- the authenticated RLS actor and the recorded actor of trusted system admission.
-- Spec: docs/architecture/features/workflow.md, V2 CRM event-source member floor.
-- [COMP:api/crm-event-scope]
CREATE FUNCTION department_read_grants_for(p_actor uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH actor AS (
    SELECT p_actor AS u,
           nullif(current_setting('app.v2_assistant_id', true), '')::uuid AS a,
           nullif(current_setting('app.v2_context_department', true), '') AS c,
           nullif(current_setting('app.v2_binding', true), '')::jsonb AS k,
           CASE WHEN nullif(current_setting('app.v2_cap', true), '') IS NULL THEN 3
                ELSE coalesce(sensitivity_rank(current_setting('app.v2_cap', true)), 0) END AS cap
  )
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'b', least(
             sensitivity_rank(CASE WHEN m.role IN ('owner', 'admin') THEN 'confidential' ELSE m.clearance END),
             CASE WHEN actor.a IS NULL THEN 3
                  ELSE coalesce((SELECT sensitivity_rank(x.clearance) FROM assistants x
                                  WHERE x.id = actor.a AND x.workspace_id = m.workspace_id), 0) END,
             actor.cap),
      'd', coalesce((
             SELECT jsonb_object_agg(e.department_id::text, least(
                      sensitivity_rank(e.clearance),
                      CASE WHEN actor.a IS NULL THEN 3 ELSE coalesce(sensitivity_rank(ae.clearance), 0) END,
                      actor.cap))
               FROM department_edges e
               LEFT JOIN department_edges ae
                 ON ae.department_id = e.department_id AND ae.assistant_id = actor.a
                AND (ae.expires_at IS NULL OR ae.expires_at > clock_timestamp())
              WHERE e.workspace_id = m.workspace_id AND e.user_id = actor.u
                AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())), '{}'::jsonb),
      'c', actor.c,
      'k', actor.k,
      'u', actor.u)), '{}'::jsonb)
    FROM actor
    JOIN workspace_members m ON m.user_id = actor.u
    JOIN workspaces wk ON wk.id = m.workspace_id AND wk.department_read_v2
   WHERE nullif(current_setting('app.current_user_id', true), '') IS NULL
      OR nullif(current_setting('app.current_user_id', true), '')::uuid = p_actor
$$;
REVOKE ALL ON FUNCTION department_read_grants_for(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION department_read_grants()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT department_read_grants_for(nullif(current_setting('app.current_user_id',true),'')::uuid)
$$;

CREATE OR REPLACE FUNCTION crm_scope_snapshot_allows(s jsonb,w uuid,actor uuid,team_grant text[],project_grant uuid[]) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE member_clearance text; member_teams text[]; teams text[]; projects uuid[];
  agent_clearance text; agent_teams jsonb; agent_projects jsonb;
  v2 boolean; grants jsonb;
BEGIN
  IF s IS NULL OR s->>'workspaceId' IS DISTINCT FROM w::text
    OR NOT(s ?& ARRAY['userId','assistantId','sensitivity','compartments','projectIds','held'])
    OR s->>'sensitivity' NOT IN('public','internal','confidential')
    OR s->>'held' IS DISTINCT FROM 'false' OR s->>'validTo' IS NOT NULL OR s->>'retractedAt' IS NOT NULL
    OR (s->>'userId' IS NOT NULL AND s->>'userId' IS DISTINCT FROM actor::text) THEN RETURN false; END IF;
  SELECT m.clearance, ws.department_read_v2 INTO member_clearance, v2
    FROM workspace_members m JOIN workspaces ws ON ws.id=m.workspace_id
   WHERE m.workspace_id=w AND m.user_id=actor;
  IF member_clearance IS NULL THEN RETURN false; END IF;
  IF nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
    AND current_setting('app.current_user_id',true)<>actor::text THEN RETURN false; END IF;
  teams=ARRAY(SELECT jsonb_array_elements_text(s->'compartments'));
  projects=ARRAY(SELECT jsonb_array_elements_text(s->'projectIds')::uuid);
  IF v2 THEN
    grants=department_read_grants_for(actor);
    IF NOT (grants ? w::text) OR NOT department_row_allows(grants,w,s->>'sensitivity',teams,(s->>'userId')::uuid) THEN RETURN false; END IF;
  ELSE
    IF sensitivity_rank(s->>'sensitivity')>sensitivity_rank(member_clearance) THEN RETURN false; END IF;
    member_teams=effective_member_team_compartments(actor,w);
    IF member_teams IS NOT NULL AND NOT teams <@ member_teams THEN RETURN false; END IF;
  END IF;
  IF (team_grant IS NOT NULL AND NOT teams <@ team_grant)
    OR (project_grant IS NOT NULL AND NOT projects <@ project_grant) THEN RETURN false; END IF;
  IF nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL
    AND current_setting('app.agent_actor_id',true)<>actor::text THEN RETURN false; END IF;
  IF NOT agent_visibility_allows(w,(s->>'userId')::uuid,(s->>'assistantId')::uuid) THEN RETURN false; END IF;
  agent_clearance=nullif(current_setting('app.agent_clearance',true),'');
  agent_teams=nullif(current_setting('app.agent_compartments',true),'')::jsonb;
  agent_projects=nullif(current_setting('app.agent_project_ids',true),'')::jsonb;
  RETURN (agent_clearance IS NULL OR sensitivity_rank(s->>'sensitivity')<=sensitivity_rank(agent_clearance))
    AND (agent_teams IS NULL OR agent_teams='null'::jsonb OR agent_teams @> to_jsonb(teams))
    AND (agent_projects IS NULL OR agent_projects='null'::jsonb OR agent_projects @> to_jsonb(projects));
END;
$$;

COMMIT;
