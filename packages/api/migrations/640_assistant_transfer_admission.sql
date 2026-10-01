BEGIN;
-- Transfers are temporarily closed until dependency-writer serialization is
-- certified. This scan provides diagnostics, NOT an emptiness certificate. No
-- content, history, connector, audience or source binding is silently reassigned.
CREATE FUNCTION public.assert_assistant_transfer_unbound(subject uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref record; bound boolean;
BEGIN
  IF EXISTS(SELECT 1 FROM public.assistants WHERE id=subject AND
    (default_workspace_group_id IS NOT NULL OR default_project_id IS NOT NULL
      OR nullif(system_prompt,'') IS NOT NULL OR nullif(bio,'') IS NOT NULL
      OR (charter IS NOT NULL AND charter <> '{}'::jsonb AND charter <> 'null'::jsonb)
      OR compartments IS NOT NULL OR cardinality(default_compartments)>0)) THEN
    RAISE EXCEPTION 'assistant_transfer_review_required';
  END IF;
  FOR ref IN
    SELECT DISTINCT n.nspname,c.relname,a.attname FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      AND a.atttypid='uuid'::regtype AND c.relname NOT IN ('assistants','assistant_members')
      AND (a.attname='assistant_id' OR a.attname LIKE '%\_assistant_id' ESCAPE '\'
        OR EXISTS(SELECT 1 FROM pg_constraint f WHERE f.contype='f' AND f.conrelid=c.oid
          AND f.confrelid='public.assistants'::regclass AND a.attnum=ANY(f.conkey)))
    ORDER BY n.nspname,c.relname,a.attname
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE %I=$1)',ref.nspname,ref.relname,ref.attname) INTO bound USING subject;
    IF bound THEN RAISE EXCEPTION 'assistant_transfer_review_required'; END IF;
  END LOOP;
END;
$$;
CREATE FUNCTION public.guard_assistant_transfer_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt jsonb;
BEGIN
  IF NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id THEN RETURN NEW; END IF;
  receipt:=nullif(current_setting('app.assistant_transfer',true),'')::jsonb;
  IF receipt IS NULL OR receipt->>'assistantId' IS DISTINCT FROM OLD.id::text
    OR receipt->>'source' IS DISTINCT FROM OLD.workspace_id::text
    OR receipt->>'destination' IS DISTINCT FROM NEW.workspace_id::text
    OR receipt->>'userId' IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'') THEN
    RAISE EXCEPTION 'assistant_transfer_admission_required';
  END IF;
  PERFORM public.assert_assistant_transfer_unbound(OLD.id);
  -- Non-FK dependency writers are not yet certified. Never mistake snapshot
  -- emptiness for a serialization proof, even with a correctly shaped receipt.
  RAISE EXCEPTION 'assistant_transfer_certification_required';
END;
$$;
CREATE TRIGGER assistant_transfer_admission BEFORE UPDATE OF workspace_id ON public.assistants
FOR EACH ROW EXECUTE FUNCTION public.guard_assistant_transfer_admission();
REVOKE ALL ON FUNCTION public.assert_assistant_transfer_unbound(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_assistant_transfer_admission() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.advance_admission_authority_policy() RETURNS trigger
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
    -- Old assistant writers may already hold the assistant row. Never wait
    -- backwards against a workspace-first admission; SQLSTATE 55P03 is retryable.
    IF TG_TABLE_NAME='assistants' THEN
      PERFORM 1 FROM public.workspaces WHERE id=target FOR UPDATE NOWAIT;
    ELSE
      PERFORM 1 FROM public.workspaces WHERE id=target FOR UPDATE;
    END IF;
    IF FOUND THEN
      INSERT INTO public.workspace_access_policies(workspace_id) VALUES(target)
        ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1;
      PERFORM pg_notify('brain_events',json_build_object('workspaceId',target,'primitive','workspace_config','action','update')::text);
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
COMMIT;
