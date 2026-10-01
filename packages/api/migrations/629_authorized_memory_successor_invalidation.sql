BEGIN;

-- The app role cannot invoke the generic cross-family invalidator. This entry
-- point accepts only a memory pointer/version, never caller-provided scope or
-- identity. It rechecks the editable predecessor under the workspace barrier.
CREATE FUNCTION public.hold_memory_successor_descendants(
  p_workspace uuid, p_memory uuid, p_version bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; target public.memories%ROWTYPE; member_role text;
BEGIN
  actor := nullif(current_setting('app.current_user_id',true),'')::uuid;
  PERFORM 1 FROM public.workspaces WHERE id=p_workspace FOR UPDATE;
  IF NOT FOUND OR actor IS NULL THEN
    RAISE EXCEPTION 'context_not_available' USING ERRCODE='42501';
  END IF;
  SELECT role INTO member_role FROM public.workspace_members
    WHERE workspace_id=p_workspace AND user_id=actor FOR SHARE;
  IF NOT FOUND OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL
    AND current_setting('app.agent_actor_id',true)<>actor::text) THEN
    RAISE EXCEPTION 'context_not_available' USING ERRCODE='42501';
  END IF;
  SELECT * INTO target FROM public.memories
    WHERE id=p_memory AND workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND OR target.valid_to IS NOT NULL OR target.retracted_at IS NOT NULL
    OR target.scope_held OR target.scope_version IS DISTINCT FROM p_version
    OR (target.user_id IS NOT NULL AND target.user_id<>actor)
    OR NOT public.member_operation_scope_allows(p_workspace,target.sensitivity,target.compartments,true)
    OR NOT public.agent_visibility_allows(p_workspace,target.user_id,target.assistant_id)
    OR NOT public.agent_read_scope_allows(target.sensitivity,target.compartments,target.project_ids)
    OR NOT public.agent_mutation_scope_allows(target.compartments)
    OR (target.assistant_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.assistants a WHERE a.id=target.assistant_id AND a.workspace_id=p_workspace))
    OR EXISTS(SELECT 1 FROM unnest(target.project_ids) required(id)
      WHERE NOT EXISTS(SELECT 1 FROM public.workspace_projects p
        WHERE p.id=required.id AND p.workspace_id=p_workspace AND p.status='active'
          AND (member_role IN('owner','admin') OR EXISTS(
            SELECT 1 FROM public.workspace_project_members pm WHERE pm.project_id=p.id AND pm.user_id=actor))))
  THEN
    RAISE EXCEPTION 'context_not_available' USING ERRCODE='42501';
  END IF;
  -- No release path, arbitrary table kind, or target scope parameters. The
  -- canonical invalidator holds only this pointer's lineage in this workspace.
  PERFORM public.hold_scope_descendants(p_workspace,'memory',target.id);
END;
$$;
REVOKE ALL ON FUNCTION public.hold_memory_successor_descendants(uuid,uuid,bigint) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    GRANT EXECUTE ON FUNCTION public.hold_memory_successor_descendants(uuid,uuid,bigint) TO app_user;
  END IF;
END $$;
COMMIT;
