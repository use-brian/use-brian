BEGIN;

-- Assistant audience, independent of its reader edges and default write home.
-- Spec: assistant-detail-page.md -> Assistant placement at creation.
ALTER TABLE public.assistants ADD COLUMN placement_department_id uuid;
ALTER TABLE public.assistants ADD CONSTRAINT assistants_placement_department_fkey
  FOREIGN KEY (workspace_id, placement_department_id)
  REFERENCES public.workspace_groups(workspace_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.assistants ADD CONSTRAINT assistants_placement_requires_workspace
  CHECK (placement_department_id IS NULL OR (workspace_id IS NOT NULL AND kind = 'standard'));

-- Also used on system-pool queries, which deliberately bypass RLS. This is
-- an additional audience restriction, never a substitute for assistant access.
CREATE FUNCTION public.assistant_placement_visible(p_actor uuid, p_assistant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.assistants a WHERE a.id = p_assistant
      AND (a.placement_department_id IS NULL OR EXISTS (
        SELECT 1 FROM public.department_edges e
        JOIN public.workspace_members m ON m.workspace_id=e.workspace_id AND m.user_id=e.user_id
        JOIN public.workspace_groups g ON g.workspace_id=e.workspace_id AND g.id=e.department_id
        WHERE e.workspace_id=a.workspace_id AND e.department_id=a.placement_department_id
          AND e.user_id=p_actor AND g.status='active'
          AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())
      ))
  )
$$;

-- Restrictive: legacy permissive workspace/direct policies cannot OR past it.
CREATE POLICY assistants_placement ON public.assistants AS RESTRICTIVE
  USING (public.assistant_placement_visible(nullif(current_setting('app.current_user_id',true),'')::uuid,id))
  WITH CHECK (placement_department_id IS NULL OR public.department_clearance_in(
    'user',nullif(current_setting('app.current_user_id',true),'')::uuid,placement_department_id) IS NOT NULL);

-- No generic PATCH, reader-edge edit, home change or workspace transfer can
-- silently release this audience. Placement changes need a future reviewed path.
CREATE FUNCTION public.guard_assistant_placement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.placement_department_id IS DISTINCT FROM OLD.placement_department_id
    OR (OLD.placement_department_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id)
  THEN RAISE EXCEPTION 'assistant_placement_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistant_placement_immutable BEFORE UPDATE OF placement_department_id,workspace_id
  ON public.assistants FOR EACH ROW EXECUTE FUNCTION public.guard_assistant_placement();
REVOKE ALL ON FUNCTION public.guard_assistant_placement() FROM PUBLIC;
-- One atomic creation boundary: no moment with a workspace-visible assistant.
CREATE FUNCTION public.create_department_assistant(p_workspace uuid,p_department uuid,p_name text,
  p_icon_seed integer,p_clearance text,p_charter jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.department_actor(); lk record; assistant uuid;
BEGIN
  SELECT * INTO lk FROM public.department_lock(p_department,NULL);
  IF lk.workspace_id IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'assistant_placement_unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=p_workspace AND user_id=actor AND role IN ('owner','admin'))
    THEN RAISE EXCEPTION 'assistant_placement_unavailable'; END IF;
  PERFORM public.department_require_owner(p_department,actor);
  INSERT INTO public.assistants(name,owner_user_id,workspace_id,icon_seed,clearance,kind,app_type,charter,placement_department_id)
    VALUES(p_name,NULL,p_workspace,p_icon_seed,p_clearance,'standard',NULL,p_charter,p_department) RETURNING id INTO assistant;
  PERFORM public.department_set_edge(p_department,'assistant',assistant,p_clearance,NULL,NULL);
  PERFORM public.department_set_home(p_workspace,'assistant',assistant,p_department);
  RETURN assistant;
END $$;
-- No outward sharing until the target surface can enforce this audience.
CREATE FUNCTION public.guard_department_assistant_sharing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ids uuid[];
BEGIN
  IF TG_TABLE_NAME='assistant_connections' THEN
    ids:=ARRAY[NEW.follower_assistant_id,NEW.following_assistant_id];
  ELSE
    ids:=ARRAY[NEW.assistant_id];
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.assistants WHERE id=ANY(ids) AND placement_department_id IS NOT NULL) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='api_keys' THEN
    IF NEW.audience='internal' AND public.assistant_placement_visible(NEW.created_by,NEW.assistant_id) THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='sessions' THEN
    IF NEW.visibility='owner' AND public.assistant_placement_visible(NEW.user_id,NEW.assistant_id) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'department_assistant_requires_private_access';
END $$;
REVOKE ALL ON FUNCTION public.guard_department_assistant_sharing() FROM PUBLIC;
CREATE TRIGGER department_assistant_sharing BEFORE INSERT OR UPDATE ON public.assistant_chat_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_assistant_sharing();
CREATE TRIGGER department_assistant_sharing BEFORE INSERT OR UPDATE ON public.channel_assistants
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_assistant_sharing();
CREATE TRIGGER department_assistant_sharing BEFORE INSERT OR UPDATE ON public.assistant_connections
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_assistant_sharing();
CREATE TRIGGER department_assistant_sharing BEFORE INSERT OR UPDATE OF assistant_id,visibility,user_id ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_assistant_sharing();
CREATE TRIGGER department_assistant_sharing BEFORE INSERT OR UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_assistant_sharing();
-- Readers can expire or be removed without changing the assistant row. Use
-- the existing authority signal so open clients discard cached identities.
CREATE TRIGGER department_assistant_audience_changed AFTER INSERT OR UPDATE OR DELETE
  ON public.department_edges FOR EACH ROW EXECUTE FUNCTION public.advance_admission_authority_policy();
COMMIT;
