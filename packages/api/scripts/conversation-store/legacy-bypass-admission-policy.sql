-- [COMP:api/migration-owner-role] Restricted current workspace admission facts.
-- Installed by the authenticated legacy bypass retirement successor.
CREATE FUNCTION public.read_workspace_admission_policy(w uuid)
RETURNS TABLE("workspaceId" uuid,mode text,"setupState" text,"departmentReadV2" boolean,
 revision text,"defaultDepartmentId" uuid,"defaultCompartment" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p.workspace_id,p.access_mode,p.setup_state,ws.department_read_v2,
  p.revision::text,p.default_department_id,g.compartment_key
 FROM public.workspace_access_policies p
 JOIN public.workspaces ws ON ws.id=p.workspace_id
 LEFT JOIN public.workspace_groups g ON g.id=p.default_department_id AND g.workspace_id=p.workspace_id
  AND g.kind='team' AND g.status='active'
 WHERE p.workspace_id=w AND (
  EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w
   AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid='public.workspace_access_policies'::regclass
   AND pg_catalog.pg_has_role(session_user,c.relowner,'USAGE')));
$$;
REVOKE ALL ON FUNCTION public.read_workspace_admission_policy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_workspace_admission_policy(uuid) TO app_user;
