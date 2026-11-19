-- [COMP:api/conversation-visibility] Source-owned native conversation authority.
-- This template is not installed by 8295. The reviewed authenticated successor
-- enrolls it and all dependent callers together before any settings route mounts.

-- Office's current root/source/grant policy, as a SQL-side anchor boundary.
-- The receiving integration matrix must compare this to resolveOfficeAccess at
-- actual native member reads before activation, including deny/revoke/expiry.
CREATE FUNCTION public.conversation_office_anchor_current(artifact uuid,actor uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $office$
 SELECT actor IS NOT DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM public.office_artifacts a
  JOIN public.workspaces w ON w.id=a.workspace_id
  JOIN public.workspace_members m ON m.workspace_id=a.workspace_id AND m.user_id=actor
  LEFT JOIN public.office_artifact_grants g ON g.artifact_id=a.id AND g.user_id=actor
  WHERE a.id=artifact AND a.lifecycle_state<>'purged'
   AND public.office_artifact_scope_allows(a.id,a.workspace_id,false)
   AND public.office_sources_scope_allows(a.id,a.workspace_id,false)
   AND public.sensitivity_rank(a.sensitivity)<=public.sensitivity_rank(
    CASE WHEN w.department_read_v2 OR m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END)
   AND (cardinality(a.visibility_user_ids)=0 OR actor=ANY(a.visibility_user_ids))
   AND (w.department_read_v2 OR public.effective_member_read_compartments(actor,a.workspace_id) IS NULL
    OR a.compartments <@ public.effective_member_read_compartments(actor,a.workspace_id))
   AND CASE WHEN a.mode='session' THEN
     a.owner_user_id=actor AND a.lifecycle_state='active' AND clock_timestamp()<a.expires_at
     AND a.default_workspace_role='deny' AND public.office_artifact_scope_allows(a.id,a.workspace_id,true)
    ELSE
     NOT coalesce(g.role='deny' AND g.revoked_at IS NULL,false)
     AND (a.lifecycle_state<>'retained' OR m.role IN ('owner','admin'))
     AND (g.role IN ('view','comment','edit') AND g.revoked_at IS NULL
      OR a.creator_user_id=actor OR a.owner_user_id=actor OR a.default_workspace_role<>'deny')
    END)
$office$;
REVOKE ALL ON FUNCTION public.conversation_office_anchor_current(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_hard_project_ids(labels text[]) RETURNS uuid[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $projects$
 SELECT ARRAY(SELECT DISTINCT substr(label,9)::uuid FROM unnest(labels) label
  WHERE label LIKE 'project:%' ORDER BY 1)
$projects$;
REVOKE ALL ON FUNCTION public.conversation_hard_project_ids(text[]) FROM PUBLIC,app_user;

-- One canonical audit state, reused by the mutation and the consent verifier.
-- The generation is separate: explicit withdrawal can advance it without
-- changing audience, while an append changes neither state nor generation.
CREATE FUNCTION public.conversation_authority_state(sid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $state$
 SELECT jsonb_build_object('sessionId',e.session_id,'workspaceId',e.workspace_id,'starterUserId',e.starter_user_id,
  'visibility',e.visibility,'cap',e.cap,'compartments',e.compartments,'projectIds',public.conversation_hard_project_ids(e.compartments),
  'contextProjectId',s.context_project_id,
  'legacyBindingDigest',CASE WHEN h.session_id IS NOT NULL THEN
   encode(sha256(convert_to(public.private_legacy_history_binding(s)::text,'UTF8')),'hex') END,
  'classification',e.classification,'participantUserIds',ARRAY(SELECT p.user_id FROM public.conversation_participants p
    WHERE p.session_id=e.session_id ORDER BY p.user_id))
 FROM public.conversation_envelopes e JOIN public.sessions s ON s.id=e.session_id
 LEFT JOIN public.session_legacy_history h ON h.session_id=e.session_id WHERE e.session_id=sid
$state$;
REVOKE ALL ON FUNCTION public.conversation_authority_state(uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_consent_current(sid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $consent$
 SELECT EXISTS(SELECT 1 FROM public.conversation_envelopes e
  JOIN LATERAL(SELECT a.after_envelope,a.next_version FROM public.conversation_visibility_audit a
   WHERE a.session_id=e.session_id ORDER BY a.next_version DESC LIMIT 1) latest ON true
  WHERE e.session_id=sid AND latest.next_version<=e.version
   AND latest.after_envelope=public.conversation_authority_state(sid))
$consent$;
REVOKE ALL ON FUNCTION public.conversation_consent_current(uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_member_tier_current(w uuid,sid uuid,actor uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $member$
DECLARE e public.conversation_envelopes;s public.sessions;m public.workspace_members;
 v2 boolean;grants jsonb;page_id uuid;artifact_id uuid;parent_id uuid;anchor_allowed boolean;
BEGIN
 IF actor IS NULL OR actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid THEN RETURN 'omitted'; END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id IS NOT DISTINCT FROM w;
 IF NOT FOUND THEN RETURN 'omitted'; END IF;
 SELECT * INTO s FROM public.sessions WHERE id=sid;
 IF NOT FOUND OR s.user_id IS DISTINCT FROM e.starter_user_id OR s.recording_privacy_held
  OR public.scope_review_state_held('session',sid) THEN RETURN 'omitted'; END IF;
 IF e.classification='member_direct' AND e.visibility<>'private_by_kind' THEN RETURN 'omitted'; END IF;
 -- A legacy private record cannot become readable merely because someone
 -- changed a current visibility/participant row. Its protected mutation must
 -- have committed the exact audience state and audit atomically.
 IF e.classification='legacy_personal' AND e.visibility='workspace'
  AND public.conversation_consent_current(sid) IS NOT TRUE THEN RETURN 'omitted'; END IF;
 -- A personal assistant outside a workspace retains its owner-only contract.
 IF w IS NULL THEN
  RETURN CASE WHEN e.starter_user_id=actor AND s.user_id=actor AND e.visibility<>'workspace' THEN 'full' ELSE 'omitted' END;
 END IF;
 SELECT * INTO m FROM public.workspace_members WHERE workspace_id=w AND user_id=actor;
 IF NOT FOUND THEN RETURN 'omitted'; END IF;
 SELECT department_read_v2 INTO v2 FROM public.workspaces WHERE id=w;
 grants:=public.department_read_grants_for(actor);
 IF v2 THEN
  IF public.department_row_allows(grants,w,e.cap,e.compartments,NULL) IS NOT TRUE THEN RETURN 'omitted'; END IF;
 ELSE
  IF public.sensitivity_rank(m.clearance)<public.sensitivity_rank(e.cap)
   OR public.effective_member_read_compartments(actor,w) IS NOT NULL
    AND NOT e.compartments <@ public.effective_member_read_compartments(actor,w) THEN RETURN 'omitted'; END IF;
 END IF;
 -- Project association is not a reader grant. Actual shared Project labels
 -- retain the canonical roster and owner-read-only oversight semantics.
 IF public.project_labels_allowed(grants,w,e.compartments,false) IS NOT TRUE THEN RETURN 'omitted'; END IF;
 CASE s.anchor_kind
 WHEN 'doc_thread' THEN
  SELECT ct.page_id INTO page_id FROM public.comment_threads ct WHERE ct.session_id=sid AND ct.workspace_id=w;
  anchor_allowed:=page_id IS NOT NULL AND public.saved_view_root_operation_scope_allows(page_id,false) IS TRUE;
 WHEN 'office_file' THEN
  SELECT l.artifact_id INTO artifact_id FROM public.office_artifact_sessions l JOIN public.office_artifacts a ON a.id=l.artifact_id
   WHERE l.session_id=sid AND a.workspace_id=w;
  anchor_allowed:=artifact_id IS NOT NULL AND public.conversation_office_anchor_current(artifact_id,actor) IS TRUE;
 WHEN 'feed_draft' THEN
  anchor_allowed:=public.feed_draft_audience_allowed(sid) IS TRUE;
 WHEN 'feed_thread' THEN
  SELECT t.session_id INTO parent_id FROM public.feed_comment_threads t JOIN public.sessions parent ON parent.id=t.session_id
   WHERE t.transcript_session_id=sid AND parent.anchor_kind='feed_draft' AND parent.workspace_id=w AND parent.assistant_id=s.assistant_id;
  anchor_allowed:=parent_id IS NOT NULL AND parent_id<>sid AND public.conversation_member_tier_current(w,parent_id,actor)='full';
 ELSE anchor_allowed:=true;
 END CASE;
 IF anchor_allowed IS NOT TRUE THEN RETURN 'omitted'; END IF;
 IF e.visibility='workspace' OR actor=e.starter_user_id OR e.visibility='configured_private'
  AND EXISTS(SELECT 1 FROM public.conversation_participants p WHERE p.session_id=sid AND p.user_id=actor)
  AND public.conversation_consent_current(sid) IS TRUE THEN RETURN 'full'; END IF;
 RETURN 'presence';
END $member$;
REVOKE ALL ON FUNCTION public.conversation_member_tier_current(uuid,uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_member_read_current(w uuid,sid uuid,actor uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $current$
 SELECT public.conversation_member_tier_current(w,sid,actor)='full'
$current$;
REVOKE ALL ON FUNCTION public.conversation_member_read_current(uuid,uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_envelope_for_reader(sid uuid,actor uuid) RETURNS public.conversation_envelopes
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $envelope$
DECLARE e public.conversation_envelopes;workspace uuid;starter uuid;
BEGIN
 IF actor IS NULL OR actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid THEN RETURN NULL;END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid;
 IF FOUND THEN RETURN e;END IF;
 SELECT coalesce(s.workspace_id,a.workspace_id),s.user_id INTO workspace,starter
 FROM public.sessions s JOIN public.assistants a ON a.id=s.assistant_id WHERE s.id=sid;
 IF NOT FOUND OR workspace IS NULL AND starter<>actor OR workspace IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=workspace AND m.user_id=actor) THEN RETURN NULL;END IF;
 -- Classify a missing legacy envelope only. It never infers a new audience
 -- from the mere fact that a caller is reading it now.
 PERFORM public.classify_conversation_envelope(sid,true);
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid;
 RETURN e;
END $envelope$;
REVOKE ALL ON FUNCTION public.conversation_envelope_for_reader(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.read_conversation_member_tiers(session_ids uuid[],include_presence boolean)
RETURNS TABLE(session_id uuid,tier text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $cohort$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 sid uuid;e public.conversation_envelopes;current_tier text;
BEGIN
 IF session_ids IS NULL OR cardinality(session_ids)>200 OR include_presence IS NULL
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR actor IS NULL THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 FOR sid IN SELECT DISTINCT id FROM unnest(session_ids) id WHERE id IS NOT NULL ORDER BY id LOOP
  e:=public.conversation_envelope_for_reader(sid,actor);
  IF e.session_id IS NULL THEN CONTINUE;END IF;
  current_tier:=public.conversation_member_tier_current(e.workspace_id,sid,actor);
  IF current_tier='full' AND e.workspace_id IS NOT NULL AND e.visibility='private_by_kind' THEN
   PERFORM public.enroll_conversation_legacy_history(sid);
  END IF;
  IF current_tier='full' OR current_tier='presence' AND include_presence THEN
   session_id:=sid;tier:=current_tier;RETURN NEXT;
  END IF;
 END LOOP;
END $cohort$;
REVOKE ALL ON FUNCTION public.read_conversation_member_tiers(uuid[],boolean) FROM PUBLIC,app_user;

-- The owner-only EXECUTE capability, not session_user, protects this port:
-- a trusted SECURITY DEFINER operation invoked by app_user legitimately checks
-- its separately bound recipient. App callers reach only GUC-bound wrappers.
-- Restoring the actor prevents a source check from changing its host.
CREATE FUNCTION public.conversation_member_read_allowed(w uuid,sid uuid,actor uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $principal$
DECLARE previous_actor text:=current_setting('app.current_user_id',true);allowed boolean;
BEGIN
 IF actor IS NULL THEN RETURN false; END IF;
 IF actor::text IS NOT DISTINCT FROM previous_actor THEN RETURN public.conversation_member_read_current(w,sid,actor); END IF;
 PERFORM set_config('app.current_user_id',actor::text,true);
 allowed:=public.conversation_member_read_current(w,sid,actor);
 PERFORM set_config('app.current_user_id',coalesce(previous_actor,''),true);
 RETURN allowed;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.current_user_id',coalesce(previous_actor,''),true);
 RAISE;
END $principal$;
REVOKE ALL ON FUNCTION public.conversation_member_read_allowed(uuid,uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_visibility_metadata_current(sid uuid,actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $metadata$
DECLARE e public.conversation_envelopes;admin boolean;hard_project boolean;
BEGIN
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid;
 IF NOT FOUND OR public.conversation_member_read_allowed(e.workspace_id,sid,actor) IS NOT TRUE THEN RETURN NULL; END IF;
 SELECT coalesce(role IN ('owner','admin'),false) INTO admin FROM public.workspace_members WHERE workspace_id=e.workspace_id AND user_id=actor;
 admin:=coalesce(admin,false);
 hard_project:=cardinality(public.conversation_hard_project_ids(e.compartments))>0;
 RETURN jsonb_build_object('conversationVisibility',e.visibility,'conversationVisibilityVersion',e.version,
  'conversationCap',e.cap,'conversationCompartments',ARRAY(SELECT label FROM unnest(e.compartments) label WHERE label NOT LIKE 'project:%' ORDER BY label),
  'conversationProjectIds',public.conversation_hard_project_ids(e.compartments),
  'participantUserIds',ARRAY(SELECT p.user_id FROM public.conversation_participants p WHERE p.session_id=sid ORDER BY p.user_id),
  'capabilities',jsonb_build_object(
   'canNarrow',e.visibility='workspace' AND (actor=e.starter_user_id OR admin),
   'canWiden',e.visibility<>'private_by_kind' AND admin,
   'canManageParticipants',e.visibility<>'private_by_kind' AND (actor=e.starter_user_id OR admin),
   'canRaiseCap',admin,
   'canMoveProject',CASE WHEN e.visibility='workspace' THEN admin OR actor=e.starter_user_id AND NOT hard_project ELSE actor=e.starter_user_id END));
END $metadata$;
REVOKE ALL ON FUNCTION public.conversation_visibility_metadata_current(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.read_conversation_visibility(sid uuid,device uuid,native_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $read$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR NOT EXISTS(SELECT 1 FROM public.auth_sessions a JOIN public.users u ON u.id=a.user_id
  WHERE a.id=device AND a.user_id=actor AND a.auth_version=native_version AND u.auth_version=native_version
   AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 PERFORM public.conversation_envelope_for_reader(sid,actor);
 RETURN public.conversation_visibility_metadata_current(sid,actor);
END $read$;
REVOKE ALL ON FUNCTION public.read_conversation_visibility(uuid,uuid,integer) FROM PUBLIC,app_user;
-- Only the authenticated successor grants this finite native wrapper to app_user.
