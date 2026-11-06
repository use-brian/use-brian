BEGIN;
ALTER TABLE oauth_authorizations
 ADD COLUMN bound_assistant_id uuid REFERENCES assistants(id) ON DELETE CASCADE,
 ADD COLUMN workspace_mcp_consent jsonb,
 DROP CONSTRAINT oauth_authorizations_audience_check,
 DROP CONSTRAINT oauth_application_audience_binding;
ALTER TABLE oauth_authorizations ADD CONSTRAINT oauth_authorizations_audience_check CHECK(audience IN ('brain','application','assistant')),
 ADD CONSTRAINT oauth_application_audience_binding CHECK(
   (audience='brain' AND application_client_id IS NULL AND bound_assistant_id IS NULL)
   OR (audience='application' AND application_client_id IS NOT NULL AND bound_assistant_id IS NULL AND workspace_mcp_consent IS NULL)
   OR (audience='assistant' AND application_client_id IS NULL AND bound_assistant_id IS NOT NULL AND workspace_mcp_consent IS NOT NULL));
CREATE FUNCTION workspace_mcp_oauth_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; session uuid; consent jsonb; reach text[];
BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.workspace_mcp_consent IS DISTINCT FROM OLD.workspace_mcp_consent
     OR NEW.bound_assistant_id IS DISTINCT FROM OLD.bound_assistant_id THEN
     RAISE EXCEPTION 'workspace_mcp_consent_immutable';
   END IF;
   IF OLD.workspace_mcp_consent IS NOT NULL AND (
     ROW(NEW.client_id,NEW.user_id,NEW.workspace_id,NEW.scope) IS DISTINCT FROM ROW(OLD.client_id,OLD.user_id,OLD.workspace_id,OLD.scope)
     OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL) THEN
     RAISE EXCEPTION 'workspace_mcp_consent_immutable';
   END IF;
   RETURN NEW;
 END IF;
 consent:=NEW.workspace_mcp_consent;
 IF consent IS NULL THEN RETURN NEW; END IF;
 actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 session:=nullif(current_setting('app.external_key_session',true),'')::uuid;
 IF programmatic_configuration_actor(NEW.workspace_id,actor,session) IS NOT TRUE OR NEW.user_id IS DISTINCT FROM actor
   THEN RAISE EXCEPTION 'workspace_mcp_native_consent_required'; END IF;
 IF NEW.audience NOT IN ('brain','assistant') OR consent->>'version' IS DISTINCT FROM '1'
   OR jsonb_typeof(consent->'operationNames') IS DISTINCT FROM 'array'
   OR jsonb_typeof(consent->'compartments') IS DISTINCT FROM 'array'
   OR jsonb_typeof(consent->'mutationCompartments') IS DISTINCT FROM 'array'
   OR jsonb_typeof(consent->'projectIds') IS DISTINCT FROM 'array'
   OR consent->>'maxClearance' IS NULL OR consent->>'maxClearance' NOT IN ('public','internal','confidential')
   OR consent->>'expiresAt' IS NULL OR (consent->>'expiresAt')::timestamptz<=clock_timestamp()
   OR (consent->>'expiresAt')::timestamptz>clock_timestamp()+interval '90 days 1 minute'
   OR jsonb_array_length(consent->'operationNames')>4096
   OR NOT EXISTS(SELECT 1 FROM assistants a WHERE a.id=(consent->>'assistantId')::uuid AND a.workspace_id=NEW.workspace_id
     AND (NEW.audience='brain' AND a.kind='primary' OR NEW.audience='assistant' AND a.id=NEW.bound_assistant_id))
   THEN RAISE EXCEPTION 'workspace_mcp_consent_invalid'; END IF;
 reach:=effective_member_team_compartments(actor,NEW.workspace_id);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(consent->'compartments') c WHERE reach IS NOT NULL AND NOT c=ANY(reach))
   OR NOT ((consent->'compartments') @> (consent->'mutationCompartments'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(consent->'projectIds') p WHERE NOT EXISTS(
     SELECT 1 FROM workspace_projects x WHERE x.id=p::uuid AND x.workspace_id=NEW.workspace_id AND x.status='active'))
   THEN RAISE EXCEPTION 'workspace_mcp_scope_unavailable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION workspace_mcp_oauth_guard() FROM PUBLIC;
CREATE TRIGGER workspace_mcp_oauth_guard BEFORE INSERT OR UPDATE ON oauth_authorizations
 FOR EACH ROW EXECUTE FUNCTION workspace_mcp_oauth_guard();
ALTER TABLE workspace_mcp_contexts ADD COLUMN oauth_authorization_id uuid REFERENCES oauth_authorizations(id) ON DELETE CASCADE,
 DROP CONSTRAINT workspace_mcp_contexts_check;
ALTER TABLE workspace_mcp_contexts ADD CHECK(num_nonnulls(brain_key_id,api_key_id,oauth_authorization_id)=1),
 ADD UNIQUE(oauth_authorization_id,selection_id);
CREATE OR REPLACE FUNCTION public.require_session_creation_admission()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE assistant_workspace uuid; current_workspace uuid;
  policy public.workspace_access_policies; receipt jsonb; actor uuid; provenance text; consent jsonb; key_kind text; key_id uuid;
BEGIN
  IF NEW.visibility IS DISTINCT FROM 'workspace' THEN RETURN NEW; END IF;
  SELECT workspace_id INTO assistant_workspace FROM public.assistants WHERE id=NEW.assistant_id;
  -- Lock both addresses, checking actual output workspace, never just assistant policy.
  PERFORM id FROM public.workspaces WHERE id IN (NEW.workspace_id,assistant_workspace) ORDER BY id FOR UPDATE;
  SELECT workspace_id INTO current_workspace FROM public.assistants WHERE id=NEW.assistant_id FOR SHARE;
  IF current_workspace IS DISTINCT FROM assistant_workspace THEN
    RAISE EXCEPTION 'access_policy_conflict' USING ERRCODE='40001';
  END IF;
  -- A separate machine receipt. No native login or human-root provenance.
  BEGIN
    receipt:=nullif(current_setting('app.session_creation_admission',true),'')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
  END;
  IF receipt->>'provenance'='workspace_mcp' THEN
    PERFORM set_config('app.session_creation_admission','',true);
    key_kind:=receipt->>'keyKind'; key_id:=(receipt->>'keyId')::uuid;
    actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
    IF key_kind='brain_key' THEN
      SELECT k.workspace_mcp_consent INTO consent FROM brain_keys k
        WHERE k.id=key_id AND k.workspace_id=NEW.workspace_id AND k.status='active'
          AND coalesce(k.issuer_user_id,k.created_by)=actor;
    ELSIF key_kind='assistant_key' THEN
      SELECT k.workspace_mcp_consent INTO consent FROM api_keys k
        WHERE k.id=key_id AND k.assistant_id=NEW.assistant_id AND k.status='active'
          AND coalesce(k.issuer_user_id,k.created_by)=actor;
    ELSIF key_kind='oauth_token' THEN
      SELECT k.workspace_mcp_consent INTO consent FROM oauth_authorizations k
        JOIN oauth_clients c ON c.client_id=k.client_id AND c.revoked_at IS NULL
        WHERE k.id=key_id AND k.workspace_id=NEW.workspace_id AND k.user_id=actor
          AND k.revoked_at IS NULL AND k.audience IN ('brain','assistant')
          AND (k.audience='brain' OR k.bound_assistant_id=NEW.assistant_id);
    END IF;
    IF consent IS NULL OR receipt->>'protocol' IS DISTINCT FROM '1'
      OR actor IS NULL OR actor IS DISTINCT FROM NEW.user_id
      OR assistant_workspace IS DISTINCT FROM NEW.workspace_id
      OR consent->>'assistantId' IS DISTINCT FROM NEW.assistant_id::text
      OR (consent->>'expiresAt')::timestamptz<=clock_timestamp()
      OR NEW.anchor_kind<>'none' OR NEW.mode IS NOT NULL OR NEW.app_origin IS NOT NULL
      OR NEW.channel_type IS DISTINCT FROM (CASE WHEN key_kind='brain_key' OR key_kind='oauth_token' AND EXISTS(SELECT 1 FROM oauth_authorizations WHERE id=key_id AND audience='brain') THEN 'programmatic' ELSE 'assistant_mcp' END)
      OR NEW.channel_id IS DISTINCT FROM 'workspace-mcp:'||key_kind||':'||key_id::text
        || (CASE WHEN receipt->>'selectionId' IS NULL THEN '' ELSE ':'||(receipt->>'selectionId') END)
      OR (receipt->>'selectionId' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.workspace_mcp_contexts c WHERE c.selection_id=(receipt->>'selectionId')::uuid
          AND c.user_id=actor AND c.workspace_id=NEW.workspace_id AND c.assistant_id=NEW.assistant_id
          AND (CASE key_kind WHEN 'brain_key' THEN c.brain_key_id=key_id WHEN 'oauth_token' THEN c.oauth_authorization_id=key_id ELSE c.api_key_id=key_id END)
          AND c.context_group_id IS NOT DISTINCT FROM NEW.context_group_id
          AND c.context_project_id IS NOT DISTINCT FROM NEW.context_project_id AND NOT c.invalidated))
      OR NEW.app_id IS DISTINCT FROM 'Use Brian'
      OR NEW.effective_clearance IS NULL
      OR array_position(ARRAY['public','internal','confidential'],NEW.effective_clearance) IS NULL
      OR array_position(ARRAY['public','internal','confidential'],NEW.effective_clearance)
        >array_position(ARRAY['public','internal','confidential'],consent->>'maxClearance')
      OR (consent->>'contextGroupId' IS NOT NULL AND consent->>'contextGroupId' IS DISTINCT FROM NEW.context_group_id::text)
      OR (consent->>'contextProjectId' IS NOT NULL AND consent->>'contextProjectId' IS DISTINCT FROM NEW.context_project_id::text)
      OR NOT ((consent->'mutationCompartments') @> to_jsonb(NEW.context_compartments))
      OR (NEW.context_project_id IS NOT NULL AND NOT ((consent->'projectIds') @> jsonb_build_array(NEW.context_project_id::text)))
      OR public.personal_web_session_scope_allows(NEW.workspace_id,actor,NEW.assistant_id,
        NEW.context_group_id,NEW.context_project_id,NEW.context_compartments) IS NOT TRUE
    THEN RAISE EXCEPTION 'workspace_mcp_session_unavailable' USING ERRCODE='42501'; END IF;
    RETURN NEW;
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
  provenance:=receipt->>'provenance';
  IF receipt IS NULL OR receipt->>'protocol' IS DISTINCT FROM '1'
    OR receipt->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
    OR receipt->>'policyRevision' IS DISTINCT FROM policy.revision::text
    OR receipt->>'assistantId' IS DISTINCT FROM NEW.assistant_id::text
    OR receipt->>'userId' IS DISTINCT FROM NEW.user_id::text
    OR receipt->>'anchorKind' IS DISTINCT FROM NEW.anchor_kind
    OR receipt->>'sensitivity' IS DISTINCT FROM NEW.effective_clearance
  THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;

  IF provenance = 'authenticated_chat_root' THEN
    -- The Chat app's room: an authenticated member's explicit destination choice.
    IF actor IS DISTINCT FROM NEW.user_id
      OR NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor)
      OR (nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
        AND nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM actor)
      OR NEW.anchor_kind <> 'none' OR NEW.mode IS NOT NULL
      OR NEW.channel_type IS DISTINCT FROM 'web' OR NEW.app_origin IS DISTINCT FROM 'chat'
      OR receipt->>'channelType' IS DISTINCT FROM NEW.channel_type
      OR receipt->>'channelId' IS DISTINCT FROM NEW.channel_id
      OR receipt->>'appId' IS DISTINCT FROM NEW.app_id
      OR receipt->>'appOrigin' IS DISTINCT FROM NEW.app_origin
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
  END IF;

  IF provenance = 'anchored_thread' THEN
    -- A doc / Office / feed thread or a feed draft: the anchor decides its
    -- audience, the app checked the actor's authority over the anchor before
    -- minting this receipt. The row must name a member (or, for a guest doc
    -- thread on a public page, the guest sentinel) and its anchor.
    IF NEW.anchor_kind NOT IN ('doc_thread','office_file','feed_draft','feed_thread')
      OR (receipt ? 'anchorRef' AND receipt->>'anchorRef' IS DISTINCT FROM NEW.anchor_ref)
      OR (actor IS DISTINCT FROM NEW.user_id)
      OR (NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor)
        AND NOT (NEW.anchor_kind='doc_thread' AND receipt->>'guest'='true' AND NEW.effective_clearance='public'))
    THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;

  IF provenance = 'channel_room' THEN
    -- A converged provider group (D15): the workspace that bound the group's
    -- channel integration owns the room.
    IF NEW.anchor_kind <> 'channel'
      OR receipt->>'channelType' IS DISTINCT FROM NEW.channel_type
      OR receipt->>'channelId' IS DISTINCT FROM NEW.channel_id
      OR NOT EXISTS(SELECT 1 FROM public.channel_integrations ci JOIN public.channels c ON c.id=ci.channel_id
        WHERE ci.id::text=receipt->>'channelIntegrationId' AND c.workspace_id=NEW.workspace_id
          AND ci.channel_type=NEW.channel_type)
    THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
END $function$;
COMMIT;
