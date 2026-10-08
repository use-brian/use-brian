-- [COMP:workflow/context-scope] Connector event admission for workflow runs.
-- Spec: docs/architecture/features/workflow.md, "Connector event admission".
-- A connector event carries provider content (mail, issues, messages) that
-- belongs to the connector's audience. In a department-read v2 workspace the
-- event may start a run only when that audience fits inside the workflow's
-- department context and the workflow's author currently holds it; a private
-- connector only reaches its owner's workflows. Checked before the storm guard
-- so an inadmissible event causes no effect at all. Legacy workspaces are
-- unchanged. Channel and brand events have no department audience (General).
BEGIN;

CREATE FUNCTION workflow_connector_event_admissible(target_workflow uuid, target_workspace uuid, instance uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH flow AS (
    SELECT wf.created_by AS author, wf.context_group_id AS grp, g.compartment_key AS context_key, ws.department_read_v2 AS v2
      FROM workflows wf
      JOIN workspaces ws ON ws.id=wf.workspace_id
      LEFT JOIN workspace_groups g ON g.id=wf.context_group_id AND g.workspace_id=wf.workspace_id AND g.kind='team'
     WHERE wf.id=target_workflow AND wf.workspace_id=target_workspace
  ), source AS (
    SELECT ci.scope, ci.user_id AS owner,
      (ci.workspace_id=target_workspace AND ci.scope='workspace') AS owned_here,
      ci.compartments AS own_labels,
      (SELECT cg.compartments FROM connector_grant cg
        WHERE cg.connector_instance_id=ci.id AND cg.target_type='workspace' AND cg.target_id=target_workspace
        ORDER BY cg.granted_at DESC, cg.id DESC LIMIT 1) AS grant_labels
      FROM connector_instance ci WHERE ci.id=instance
  ), audience AS (
    SELECT source.*, CASE WHEN owned_here THEN coalesce(own_labels,'{}') ELSE grant_labels END AS labels FROM source
  )
  SELECT coalesce((
    SELECT CASE
      WHEN NOT flow.v2 THEN true
      WHEN flow.grp IS NOT NULL AND flow.context_key IS NULL THEN false
      -- Not exposed to this workspace: only a private connector's own owner may listen.
      WHEN NOT audience.owned_here AND audience.labels IS NULL
        THEN audience.scope='user' AND audience.owner=flow.author
      ELSE audience.labels <@ (CASE WHEN flow.context_key IS NULL THEN ARRAY[]::text[] ELSE ARRAY[flow.context_key] END)
        AND coalesce(department_row_allows(department_read_grants_for(flow.author),target_workspace,'public',audience.labels,NULL),false)
    END
    FROM flow, audience
  ),false)
$$;
REVOKE ALL ON FUNCTION workflow_connector_event_admissible(uuid,uuid,uuid) FROM PUBLIC;

COMMIT;
