-- Bounded authenticated personal web/chat roots. 633 remains the shared/draft
-- backstop; this provenance can never authorize shared rows. No activation.
BEGIN;
-- Receipts bind a call but are not authority: app callers can set GUCs.
-- This predicate is also used by the personal store, after its workspace lock.
-- Grants remain the canonical member-operation and assistant context tables;
-- no persisted grant copy, mode default, or receipt-supplied ceiling is used.
CREATE FUNCTION personal_web_session_scope_allows(w uuid, actor uuid, aid uuid,
  team uuid, project uuid, compartments text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.assistants; member_role text; team_key text;
BEGIN
 IF actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid THEN RETURN false; END IF;
 SELECT * INTO a FROM public.assistants WHERE id=aid AND workspace_id=w;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT role INTO member_role FROM public.workspace_members WHERE workspace_id=w AND user_id=actor;
 IF NOT FOUND THEN RETURN false; END IF;
 -- Same member mutation/clearance floor as canonical creation admission (615).
 -- The assistant's clearance is the conservative input floor; owner visibility
 -- does not grant a member authority to create a higher-clearance context.
 IF public.member_operation_scope_allows(w,a.clearance,compartments,true) IS NOT TRUE THEN RETURN false; END IF;
 IF team IS NULL THEN
  IF compartments IS DISTINCT FROM '{}'::text[] THEN RETURN false; END IF;
 ELSE
  SELECT compartment_key INTO team_key FROM public.workspace_groups
    WHERE id=team AND workspace_id=w AND kind='team' AND status='active';
  IF NOT FOUND OR compartments IS DISTINCT FROM ARRAY[team_key] THEN RETURN false; END IF;
  -- resolveAssistantPrincipalSystem: all is universe; legacy is the direct
  -- array; assigned intersects that array with the assigned Team read bundles.
  -- Even read_all does not erase the direct ceiling applied by resolveScope.
  IF a.team_scope_mode<>'all' AND a.compartments IS NOT NULL
    AND NOT compartments <@ a.compartments THEN RETURN false; END IF;
  IF a.team_scope_mode='assigned' AND NOT EXISTS (
    SELECT 1 FROM public.workspace_group_assistants ga
    JOIN public.workspace_groups g ON g.id=ga.group_id
    WHERE ga.assistant_id=aid AND g.workspace_id=w AND g.kind='team'
      AND (g.read_all OR g.compartment_key=team_key OR EXISTS (
        SELECT 1 FROM public.workspace_group_compartment_grants gcg
        WHERE gcg.group_id=g.id AND gcg.compartment_key=team_key))
  ) THEN RETURN false; END IF;
 END IF;
 IF project IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.workspace_projects WHERE id=project AND workspace_id=w AND status='active') THEN RETURN false; END IF;
  -- Same member Project floor as admitWorkspaceResource; assistant assignment
  -- narrows it further, never replaces the executing member's authority.
  IF member_role NOT IN ('owner','admin') AND NOT EXISTS (
    SELECT 1 FROM public.workspace_project_members WHERE project_id=project AND user_id=actor
  ) THEN RETURN false; END IF;
  IF a.project_scope_mode='assigned' AND NOT EXISTS (
    SELECT 1 FROM public.assistant_project_grants WHERE project_id=project AND assistant_id=aid
  ) THEN RETURN false; END IF;
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION require_personal_web_session_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.workspace_access_policies; r jsonb; aw uuid;
BEGIN
 IF NEW.visibility<>'owner' OR NEW.mode IS NOT NULL OR NEW.channel_type<>'web' OR NEW.app_origin IS DISTINCT FROM 'chat' THEN RETURN NEW; END IF;
 SELECT workspace_id INTO aw FROM public.assistants WHERE id=NEW.assistant_id;
 PERFORM id FROM public.workspaces WHERE id IN (aw,NEW.workspace_id) ORDER BY id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.workspace_access_policies WHERE workspace_id IN(aw,NEW.workspace_id) AND setup_state<>'legacy') THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.assistants WHERE id=NEW.assistant_id AND workspace_id=NEW.workspace_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'personal_session_locality_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM public.workspace_access_policies WHERE workspace_id=NEW.workspace_id;
 BEGIN
  r:=nullif(current_setting('app.session_creation_admission',true),'')::jsonb;
 EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'personal_session_admission_required' USING ERRCODE='42501';
 END;
 PERFORM set_config('app.session_creation_admission','',true);
 IF r IS NULL OR r->>'protocol' IS DISTINCT FROM '1'
 OR r->>'provenance' IS DISTINCT FROM 'authenticated_personal_web'
 OR r->>'actorUserId' IS DISTINCT FROM NEW.user_id::text
 OR nullif(current_setting('app.current_user_id',true),'') IS DISTINCT FROM NEW.user_id::text
 OR r->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
 OR r->>'policyRevision' IS DISTINCT FROM p.revision::text
 OR r->>'assistantId' IS DISTINCT FROM NEW.assistant_id::text
 OR r->>'userId' IS DISTINCT FROM NEW.user_id::text
 OR r->>'channelId' IS DISTINCT FROM NEW.channel_id
 OR r->>'appId' IS DISTINCT FROM NEW.app_id
 OR r->>'contextGroupId' IS DISTINCT FROM NEW.context_group_id::text
 OR r->>'contextProjectId' IS DISTINCT FROM NEW.context_project_id::text
 OR r->'compartments' IS DISTINCT FROM to_jsonb(NEW.context_compartments)
 OR NEW.effective_clearance IS NOT NULL
 THEN RAISE EXCEPTION 'personal_session_admission_required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.auth_sessions s JOIN public.users u ON u.id=s.user_id
 JOIN public.workspace_members m ON m.user_id=u.id AND m.workspace_id=NEW.workspace_id
 WHERE s.id::text=r->>'authSessionId' AND u.id=NEW.user_id
 AND s.auth_version::text=r->>'authVersion' AND u.auth_version=s.auth_version
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF s,u,m;
 IF NOT FOUND THEN RAISE EXCEPTION 'personal_session_principal_unavailable' USING ERRCODE='42501'; END IF;
 IF public.personal_web_session_scope_allows(NEW.workspace_id,NEW.user_id,NEW.assistant_id,
   NEW.context_group_id,NEW.context_project_id,NEW.context_compartments) IS NOT TRUE THEN
  RAISE EXCEPTION 'personal_session_scope_unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zzzz_personal_web_session_admission BEFORE INSERT ON sessions
 FOR EACH ROW EXECUTE FUNCTION require_personal_web_session_admission();
REVOKE ALL ON FUNCTION require_personal_web_session_admission() FROM PUBLIC;
-- Upgrade the 633 trigger only after its shared authority dependency exists.
CREATE OR REPLACE FUNCTION public.require_session_creation_admission() RETURNS trigger
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
    WHERE workspace_id IN (NEW.workspace_id,assistant_workspace) AND setup_state<>'legacy') THEN
    -- Receipt-free legacy compatibility is not ready-mode admission.
    IF nullif(current_setting('app.session_creation_admission',true),'') IS NOT NULL THEN
      RAISE EXCEPTION 'workspace_creation_policy_not_ready' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
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
  -- A matched receipt/row pair is not a grant. Resolve live member and
  -- assistant caps with the same predicate as personal creation, then apply
  -- shared-only placement and sensitivity rules. Do not default a row here.
  IF policy.setup_state IS DISTINCT FROM 'ready'
    OR (policy.access_mode='simple' AND (policy.default_department_id IS NULL
      OR NEW.context_group_id IS DISTINCT FROM policy.default_department_id))
    OR NEW.effective_clearance IS DISTINCT FROM (SELECT clearance FROM public.assistants WHERE id=NEW.assistant_id)
    OR public.personal_web_session_scope_allows(NEW.workspace_id,actor,NEW.assistant_id,
      NEW.context_group_id,NEW.context_project_id,NEW.context_compartments) IS NOT TRUE
  THEN RAISE EXCEPTION 'workspace_creation_scope_unavailable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
COMMIT;
