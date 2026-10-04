-- Admission holds the workspace row. Project and assistant authority changes
-- must take that same barrier (including direct/background writes), not race
-- the metadata snapshot used to admit a resource or confirm a migration.
BEGIN;
CREATE FUNCTION public.advance_admission_authority_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_row jsonb; new_row jsonb; old_workspace uuid; new_workspace uuid; target uuid;
BEGIN
  old_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME IN('workspace_project_members','assistant_project_grants') THEN
    SELECT workspace_id INTO old_workspace FROM public.workspace_projects WHERE id=(old_row->>'project_id')::uuid;
    SELECT workspace_id INTO new_workspace FROM public.workspace_projects WHERE id=(new_row->>'project_id')::uuid;
  ELSE
    old_workspace:=(old_row->>'workspace_id')::uuid;
    new_workspace:=(new_row->>'workspace_id')::uuid;
  END IF;
  FOR target IN SELECT DISTINCT id FROM unnest(ARRAY[old_workspace,new_workspace]) AS affected(id) WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM 1 FROM public.workspaces WHERE id=target FOR UPDATE;
    IF FOUND THEN
      INSERT INTO public.workspace_access_policies(workspace_id) VALUES(target)
        ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1;
      PERFORM pg_notify('brain_events',json_build_object('workspaceId',target,'primitive','workspace_config','action','update')::text);
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER workspace_admission_authority BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_projects
  FOR EACH ROW EXECUTE FUNCTION public.advance_admission_authority_policy();
CREATE TRIGGER workspace_admission_authority BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_project_members
  FOR EACH ROW EXECUTE FUNCTION public.advance_admission_authority_policy();
CREATE TRIGGER workspace_admission_authority BEFORE INSERT OR UPDATE OR DELETE ON public.assistant_project_grants
  FOR EACH ROW EXECUTE FUNCTION public.advance_admission_authority_policy();
CREATE TRIGGER workspace_admission_authority BEFORE INSERT OR DELETE OR UPDATE OF
  workspace_id,owner_user_id,kind,clearance,compartments,default_compartments,
  team_scope_mode,project_scope_mode,default_workspace_group_id,default_project_id
  ON public.assistants FOR EACH ROW EXECUTE FUNCTION public.advance_admission_authority_policy();
REVOKE ALL ON FUNCTION public.advance_admission_authority_policy() FROM PUBLIC;
COMMIT;
