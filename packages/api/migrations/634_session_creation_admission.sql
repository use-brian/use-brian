-- Bounded authenticated chat-root coverage only. No activation.
-- No existing-identity exemption: BEFORE INSERT also runs for ON CONFLICT;
-- canonical resumes UPDATE the actual row, never authorize a proposed row.
BEGIN;
CREATE FUNCTION public.require_session_creation_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE assistant_workspace uuid; current_workspace uuid;
  policy public.workspace_access_policies; receipt jsonb; actor uuid;
BEGIN
  IF NEW.visibility IS DISTINCT FROM 'workspace' AND NEW.mode IS DISTINCT FROM 'draft' THEN RETURN NEW; END IF;
  SELECT workspace_id INTO assistant_workspace FROM public.assistants WHERE id=NEW.assistant_id;
  -- Lock both addresses, checking actual output workspace, never just assistant policy.
  PERFORM id FROM public.workspaces WHERE id IN (NEW.workspace_id,assistant_workspace) ORDER BY id FOR UPDATE;
  SELECT workspace_id INTO current_workspace FROM public.assistants WHERE id=NEW.assistant_id FOR SHARE;
  IF current_workspace IS DISTINCT FROM assistant_workspace THEN
    RAISE EXCEPTION 'access_policy_conflict' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_access_policies
    WHERE workspace_id IN (NEW.workspace_id,assistant_workspace) AND setup_state<>'legacy') THEN RETURN NEW; END IF;
  IF NEW.workspace_id IS NULL OR assistant_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO policy FROM public.workspace_access_policies WHERE workspace_id=NEW.workspace_id;
  BEGIN
    receipt:=nullif(current_setting('app.session_creation_admission',true),'')::jsonb;
    actor:=(receipt->>'actor')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
  END;
  PERFORM set_config('app.session_creation_admission','',true);
  IF receipt IS NULL OR receipt->>'protocol' IS DISTINCT FROM '1'
    OR receipt->>'provenance' IS DISTINCT FROM 'authenticated_chat_root'
    OR receipt->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
    OR receipt->>'policyRevision' IS DISTINCT FROM policy.revision::text
    OR actor IS DISTINCT FROM NEW.user_id
    OR NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor)
    OR (nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
      AND nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM actor)
    OR NEW.visibility IS DISTINCT FROM 'workspace' OR NEW.mode IS NOT NULL
    OR NEW.channel_type IS DISTINCT FROM 'web' OR NEW.app_origin IS DISTINCT FROM 'chat'
    OR receipt->>'assistantId' IS DISTINCT FROM NEW.assistant_id::text
    OR receipt->>'userId' IS DISTINCT FROM NEW.user_id::text
    OR receipt->>'channelType' IS DISTINCT FROM NEW.channel_type
    OR receipt->>'channelId' IS DISTINCT FROM NEW.channel_id
    OR receipt->>'appId' IS DISTINCT FROM NEW.app_id
    OR receipt->>'appOrigin' IS DISTINCT FROM NEW.app_origin
    OR receipt->>'visibility' IS DISTINCT FROM NEW.visibility
    OR receipt->>'mode' IS DISTINCT FROM NEW.mode
    OR receipt->>'sensitivity' IS DISTINCT FROM NEW.effective_clearance
    OR receipt->>'groupId' IS DISTINCT FROM NEW.context_group_id::text
    OR receipt->>'projectId' IS DISTINCT FROM NEW.context_project_id::text
    OR receipt->'compartments' IS DISTINCT FROM to_jsonb(NEW.context_compartments)
  THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzzz_session_creation_admission BEFORE INSERT ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.require_session_creation_admission();
REVOKE ALL ON FUNCTION public.require_session_creation_admission() FROM PUBLIC;
COMMIT;
