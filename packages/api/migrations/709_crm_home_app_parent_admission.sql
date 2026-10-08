BEGIN;
-- [COMP:api/crm-integration-auth] Current app/viewer and exact token expiry.
CREATE FUNCTION public.crm_home_app_parent_current(evidence jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_home_apps a
    JOIN public.workspace_members m ON m.workspace_id=a.workspace_id
    WHERE a.id=(evidence->>'credentialId')::uuid
      AND a.workspace_id=(evidence->>'workspaceId')::uuid
      AND m.user_id=(evidence->>'userId')::uuid AND m.role IN ('owner','admin')
      AND a.status='active' AND a.granted_scopes->>'data'='read_write'
      AND jsonb_strip_nulls(jsonb_build_object('data',a.granted_scopes->'data','store',a.granted_scopes->'store','agent',a.granted_scopes->'agent'))=evidence->'grantedScopes'
      AND coalesce(to_jsonb(a.max_clearance),'null'::jsonb)=evidence->'maxClearance'
      AND (evidence->>'expiresAt')::timestamptz>clock_timestamp()
    FOR SHARE OF a,m
  );
$$;
COMMIT;
