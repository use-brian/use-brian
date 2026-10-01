BEGIN;

-- Teamspaces have SELECT-only app RLS. A fixed SECURITY DEFINER lock avoids
-- granting UPDATE authority merely to stabilize page-creation metadata.
-- This is not page admission: callers must still check ordinary principal,
-- mutation, sensitivity, Project and ambient-agent bounds after this returns.
CREATE FUNCTION public.lock_page_placement_teamspace(p_workspace uuid, p_teamspace uuid)
RETURNS TABLE(id uuid, department_id uuid, compartment text, sensitivity text, is_default boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; target public.teamspaces%ROWTYPE;
BEGIN
  actor := nullif(current_setting('app.current_user_id',true),'')::uuid;
  -- Workspace is always the first row lock, including direct app-role calls.
  PERFORM 1 FROM public.workspaces w WHERE w.id=p_workspace FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id=p_workspace AND wm.user_id=actor
  ) THEN
    RAISE EXCEPTION 'context_not_available' USING ERRCODE='42501';
  END IF;
  SELECT t.* INTO target FROM public.teamspaces t
    WHERE t.id=p_teamspace AND t.workspace_id=p_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Group/Project metadata uses the existing workspace barrier. Do not take
  -- inverse-order row locks against their workspace-locking triggers.
  RETURN QUERY SELECT target.id,target.workspace_group_id,g.compartment_key,
    target.sensitivity,target.is_default
    FROM public.workspace_groups g
    WHERE g.id=target.workspace_group_id AND g.workspace_id=p_workspace
      AND g.kind='team' AND g.status='active';
END;
$$;
REVOKE ALL ON FUNCTION public.lock_page_placement_teamspace(uuid,uuid) FROM PUBLIC;
-- Bootstrap fixtures may create their app role after migrations; deployment
-- and those fixtures must grant this exact signature to their app role.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    GRANT EXECUTE ON FUNCTION public.lock_page_placement_teamspace(uuid,uuid) TO app_user;
  END IF;
END $$;
COMMIT;
