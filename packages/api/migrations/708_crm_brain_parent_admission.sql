BEGIN;
-- [COMP:api/crm-integration-auth] Exact parent admission without exposing key rows.
CREATE FUNCTION public.crm_brain_parent_current(evidence jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.brain_keys k JOIN public.workspaces w ON w.id=k.workspace_id
    WHERE k.id=(evidence->>'credentialId')::uuid
      AND k.workspace_id=(evidence->>'workspaceId')::uuid
      AND w.owner_user_id=(evidence->>'userId')::uuid
      AND k.status='active' AND k.scope='read_write'
      AND public.external_brain_key_current(k.id) IS TRUE
      AND encode(sha256(convert_to(to_jsonb(k.key_hash)::text,'UTF8')),'hex')=evidence->>'tokenFingerprint'
      AND coalesce(to_jsonb(k.max_clearance),'null'::jsonb)=evidence->'maxClearance'
      AND coalesce(to_jsonb(k.context_group_id),'null'::jsonb)=evidence->'contextGroupId'
      AND coalesce(to_jsonb(k.context_project_id),'null'::jsonb)=evidence->'contextProjectId'
      AND coalesce(to_jsonb(k.configuration_session_id),'null'::jsonb)=evidence->'configurationSessionId'
      AND coalesce(to_jsonb(k.admitted_compartments),'null'::jsonb)=evidence->'admittedCompartments'
      AND coalesce(to_jsonb(k.admitted_project_ids),'null'::jsonb)=evidence->'admittedProjectIds'
    FOR SHARE OF k,w
  );
$$;
COMMIT;
