-- Spec: docs/architecture/integrations/mcp-workspace.md -> Retained Goals
-- [COMP:api/workspace-mcp] Preserve native authentication or the exact MCP parent.
BEGIN;
DO $migration$
DECLARE definition text; needle text; replacement text; signature text;
BEGIN
 definition:=pg_get_functiondef('public.retained_task_goal_source_current(uuid,boolean)'::regprocedure);
 needle:=$old$  OR origin->>'visibility' IS DISTINCT FROM 'personal'
  OR origin->>'kind' IS DISTINCT FROM 'session' OR origin->>'authorityUserId' IS DISTINCT FROM actor::text
  OR origin->>'executingAssistantId' IS DISTINCT FROM saved.proof->>'assistantId'
  OR origin->>'workspaceId' IS DISTINCT FROM w::text OR origin->>'systemRead' IS DISTINCT FROM 'false'
  OR origin->>'ignoreSessionBinding' IS DISTINCT FROM 'false'
$old$;
 replacement:=$new$  OR (CASE WHEN saved.proof->'authority' ? 'workspaceDelegation' THEN
    origin->>'kind' IS DISTINCT FROM 'invocation' OR origin ? 'nativeCredential'
    OR saved.proof#>>'{authority,workspaceDelegation,userId}' IS DISTINCT FROM actor::text
    OR saved.proof#>>'{authority,workspaceDelegation,workspaceId}' IS DISTINCT FROM w::text
    OR saved.proof#>>'{authority,workspaceDelegation,assistantId}' IS DISTINCT FROM saved.proof->>'assistantId'
    OR workspace_mcp_parent_current(saved.proof#>'{authority,workspaceDelegation}') IS NOT TRUE
   ELSE (
    origin->>'visibility' IS DISTINCT FROM 'personal'
  OR origin->>'kind' IS DISTINCT FROM 'session' OR origin->>'authorityUserId' IS DISTINCT FROM actor::text
  OR origin->>'executingAssistantId' IS DISTINCT FROM saved.proof->>'assistantId'
  OR origin->>'workspaceId' IS DISTINCT FROM w::text OR origin->>'systemRead' IS DISTINCT FROM 'false'
  OR origin->>'ignoreSessionBinding' IS DISTINCT FROM 'false'
   ) END)
$new$;
 IF (length(definition)-length(replace(definition,needle,'')))<>length(needle) THEN RAISE EXCEPTION 'retained_goal_origin_contract_changed';END IF;
 definition:=replace(definition,needle,replacement);
 needle:=$old$  OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=(origin->>'id')::uuid AND s.workspace_id=w
    AND s.user_id=(origin->>'userId')::uuid AND s.assistant_id=(origin->>'assistantId')::uuid
    AND s.context_group_id IS NOT DISTINCT FROM (origin->>'contextGroupId')::uuid
    AND s.context_project_id IS NOT DISTINCT FROM (origin->>'contextProjectId')::uuid
    AND date_trunc('milliseconds',s.context_locked_at)=(origin->>'contextLockedAt')::timestamptz AND s.visibility='personal' AND s.mode IS NULL
    AND s.context_binding_origin<>'held' AND s.effective_clearance IS NOT DISTINCT FROM origin->>'effectiveClearance'
    AND coalesce(to_jsonb(s.context_compartments),'[]'::jsonb) @> (origin->'contextCompartments')
    AND (origin->'contextCompartments') @> coalesce(to_jsonb(s.context_compartments),'[]'::jsonb))
$old$;
 replacement:=$new$  OR (NOT (saved.proof->'authority' ? 'workspaceDelegation') AND (
    NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=(origin->>'id')::uuid AND s.workspace_id=w
    AND s.user_id=(origin->>'userId')::uuid AND s.assistant_id=(origin->>'assistantId')::uuid
    AND s.context_group_id IS NOT DISTINCT FROM (origin->>'contextGroupId')::uuid
    AND s.context_project_id IS NOT DISTINCT FROM (origin->>'contextProjectId')::uuid
    AND date_trunc('milliseconds',s.context_locked_at)=(origin->>'contextLockedAt')::timestamptz AND s.visibility='personal' AND s.mode IS NULL
    AND s.context_binding_origin<>'held' AND s.effective_clearance IS NOT DISTINCT FROM origin->>'effectiveClearance'
    AND coalesce(to_jsonb(s.context_compartments),'[]'::jsonb) @> (origin->'contextCompartments')
    AND (origin->'contextCompartments') @> coalesce(to_jsonb(s.context_compartments),'[]'::jsonb))
  ))
$new$;
 IF (length(definition)-length(replace(definition,needle,'')))<>length(needle) THEN RAISE EXCEPTION 'retained_goal_session_contract_changed';END IF;
 EXECUTE replace(definition,needle,replacement);
 FOREACH signature IN ARRAY ARRAY['public.retained_goal_workflow_current(uuid,boolean)','public.bind_retained_goal_workflow_run(uuid,uuid)'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  needle:=$old$OR s.proof#>'{retained,sourceAuthority,nativeCredential}' IS NULL$old$;
  replacement:=$new$OR (s.proof#>'{retained,sourceAuthority,nativeCredential}' IS NULL
    AND workspace_mcp_parent_current(s.proof#>'{authority,workspaceDelegation}') IS NOT TRUE)$new$;
  IF (length(definition)-length(replace(definition,needle,'')))<>length(needle) THEN RAISE EXCEPTION 'retained_goal_workflow_origin_contract_changed';END IF;
  EXECUTE replace(definition,needle,replacement);
 END LOOP;
END $migration$;
COMMIT;
