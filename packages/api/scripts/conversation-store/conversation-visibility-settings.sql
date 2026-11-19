-- [COMP:api/conversation-visibility] The native settings owner keeps the
-- settings transition, access generation, audit and durable notice atomic.
CREATE TABLE public.conversation_settings_transitions(
 transaction_id xid8 NOT NULL,
 session_id uuid NOT NULL REFERENCES public.conversation_envelopes(session_id) ON DELETE CASCADE,
 previous_project_id uuid,
 next_project_id uuid,
 previous_compartments text[] NOT NULL,
 next_compartments text[] NOT NULL,
 PRIMARY KEY(transaction_id,session_id)
);
ALTER TABLE public.conversation_settings_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_settings_transitions FROM PUBLIC,app_user;
CREATE TABLE public.conversation_visibility_notices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL REFERENCES public.conversation_envelopes(session_id) ON DELETE CASCADE,
 audit_id uuid NOT NULL REFERENCES public.conversation_visibility_audit(id) ON DELETE CASCADE,
 recipient_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('narrowed','widened','participant_added','project_boundary_removed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(audit_id,recipient_user_id,kind)
);
CREATE INDEX conversation_visibility_notices_recipient ON public.conversation_visibility_notices(recipient_user_id,created_at,id);
ALTER TABLE public.conversation_visibility_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_visibility_notices FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_settings_transition_matches(sid uuid,previous_project uuid,next_project uuid,
 previous_compartments text[],next_compartments text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $transition$
 SELECT EXISTS(SELECT 1 FROM public.conversation_settings_transitions t WHERE transaction_id=pg_current_xact_id_if_assigned() AND session_id=sid
  AND t.previous_project_id IS NOT DISTINCT FROM previous_project AND t.next_project_id IS NOT DISTINCT FROM next_project
  AND t.previous_compartments=previous_compartments AND t.next_compartments=next_compartments)
$transition$;
REVOKE ALL ON FUNCTION public.conversation_settings_transition_matches(uuid,uuid,uuid,text[],text[]) FROM PUBLIC,app_user;

CREATE FUNCTION public.mutate_conversation_settings(sid uuid,device uuid,native_version integer,expected_version bigint,
 operation text,choice text,requested_participants jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $mutation$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 s public.sessions;e public.conversation_envelopes;w uuid;before_state jsonb;audit_id uuid;
 admin boolean;starter boolean;current_participants uuid[];next_participants uuid[];member_id uuid;
 next_visibility text;next_cap text;next_project uuid;next_labels text[];next_projects uuid[];promote_legacy boolean:=false;
 previous_hard_projects uuid[];participant_added uuid[];notice text;metadata jsonb;published_version bigint;
BEGIN
 IF expected_version IS NULL OR expected_version<1 OR operation IS NULL OR operation NOT IN('visibility','cap','project','legacy_promotion')
  OR actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 SELECT workspace_id INTO w FROM public.conversation_envelopes WHERE session_id=sid;
 IF w IS NULL THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
 SELECT role IN('owner','admin') INTO admin FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 PERFORM a.id FROM public.auth_sessions a JOIN public.users u ON u.id=a.user_id
  WHERE a.id=device AND a.user_id=actor AND a.auth_version=native_version AND u.auth_version=native_version
   AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() FOR SHARE OF a,u;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM public.sessions WHERE id=sid FOR UPDATE;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id=w FOR UPDATE;
 IF NOT FOUND OR public.session_recording_read_allowed(sid) IS NOT TRUE OR public.scope_review_state_held('session',sid)
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 starter:=actor=e.starter_user_id;
 IF (NOT admin AND NOT starter OR NOT admin AND public.conversation_member_read_current(w,sid,actor) IS NOT TRUE)
  OR operation='cap' AND NOT admin
  OR e.visibility='private_by_kind' AND operation='visibility'
  OR operation='project' AND e.visibility<>'workspace' AND NOT starter
  OR operation='legacy_promotion' AND (NOT starter OR e.visibility<>'private_by_kind'
   OR s.workspace_id IS NOT NULL AND s.workspace_id IS DISTINCT FROM w
   OR public.conversation_member_read_current(w,sid,actor) IS NOT TRUE)
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
 IF e.version<>expected_version THEN RAISE EXCEPTION 'conversation_visibility_conflict' USING ERRCODE='40001';END IF;
 before_state:=public.conversation_authority_state(sid);
 SELECT coalesce(array_agg(user_id ORDER BY user_id),'{}') INTO current_participants FROM public.conversation_participants WHERE session_id=sid;
 next_participants:=current_participants;next_visibility:=e.visibility;next_cap:=e.cap;next_project:=s.context_project_id;
 next_labels:=e.compartments;next_projects:=e.project_ids;
 previous_hard_projects:=public.conversation_hard_project_ids(e.compartments);
 IF operation='visibility' THEN
  IF choice IS NULL OR choice NOT IN('configured_private','workspace')
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  next_visibility:=choice;
  IF requested_participants IS NOT NULL THEN
   IF jsonb_typeof(requested_participants) IS DISTINCT FROM 'array' OR jsonb_array_length(requested_participants)>1000
   THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
   SELECT coalesce(array_agg(value::uuid ORDER BY value::uuid),'{}') INTO next_participants FROM jsonb_array_elements_text(requested_participants);
   IF array_position(next_participants,NULL) IS NOT NULL OR e.starter_user_id=ANY(next_participants)
     OR cardinality(next_participants)<>(SELECT count(DISTINCT u) FROM unnest(next_participants) u)
   THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  END IF;
  participant_added:=ARRAY(SELECT u FROM unnest(next_participants) u WHERE NOT u=ANY(current_participants));
  IF NOT admin AND (cardinality(participant_added)>0 OR next_visibility='workspace' AND e.visibility<>'workspace')
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  IF requested_participants IS NOT NULL THEN
   FOREACH member_id IN ARRAY next_participants LOOP
    PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=member_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
   END LOOP;
  END IF;
  IF next_visibility='workspace' AND e.visibility<>'workspace' THEN notice:='widened';END IF;
  IF next_visibility='configured_private' AND e.visibility='workspace' THEN notice:='narrowed';END IF;
 ELSIF operation='cap' THEN
  IF choice IS NULL OR choice NOT IN('public','internal','confidential') THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  IF public.sensitivity_rank(choice)<public.sensitivity_rank(e.cap)
  THEN RAISE EXCEPTION 'conversation_cap_cannot_lower' USING ERRCODE='22023';END IF;
  next_cap:=choice;
 ELSIF operation='project' THEN
  next_project:=choice::uuid;
  IF next_project IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workspace_projects p WHERE p.workspace_id=w AND p.id=next_project AND p.status='active')
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  IF e.visibility='workspace' AND next_project IS DISTINCT FROM s.context_project_id THEN
   IF cardinality(previous_hard_projects)>0 AND NOT admin
   THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
   IF next_project IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.project_shared_scopes ps WHERE ps.workspace_id=w AND ps.project_id=next_project AND ps.status='active')
   THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
   next_labels:=ARRAY(SELECT label FROM unnest(e.compartments) label WHERE label NOT LIKE 'project:%');
   IF next_project IS NOT NULL THEN
    next_labels:=ARRAY(SELECT label FROM unnest(next_labels||('project:'||next_project::text)) label ORDER BY label);
   END IF;
   IF cardinality(previous_hard_projects)>0 AND (next_project IS NULL OR NOT next_project=ANY(previous_hard_projects))
   THEN notice:='project_boundary_removed';END IF;
  END IF;
  next_projects:=public.conversation_hard_project_ids(next_labels);
 ELSE
  IF public.enroll_conversation_legacy_history(sid) IS NOT TRUE
   OR public.conversation_legacy_enrolled(sid,w,actor,s.assistant_id) IS NOT TRUE
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  promote_legacy:=s.workspace_id IS NULL;
 END IF;

 IF promote_legacy OR (next_visibility,next_cap,next_project,next_labels,next_projects,next_participants)
  IS DISTINCT FROM (e.visibility,e.cap,s.context_project_id,e.compartments,e.project_ids,current_participants) THEN
  -- Prove the exact immutable 8203 parent before a reviewed mutation changes
  -- it. A mismatch remains withheld and is never repaired by this transition.
  IF e.visibility='private_by_kind' AND EXISTS(SELECT 1 FROM public.session_legacy_history WHERE session_id=sid)
   AND public.enroll_conversation_legacy_history(sid) IS NOT TRUE
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  IF promote_legacy THEN
   UPDATE public.sessions SET workspace_id=w WHERE id=sid AND workspace_id IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'conversation_visibility_conflict' USING ERRCODE='40001';END IF;
  END IF;
  IF next_project IS DISTINCT FROM s.context_project_id OR next_labels IS DISTINCT FROM e.compartments THEN
   INSERT INTO public.conversation_settings_transitions VALUES(pg_current_xact_id(),sid,s.context_project_id,next_project,
    s.context_compartments,next_labels)
   ON CONFLICT(transaction_id,session_id) DO NOTHING;
   IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
   UPDATE public.sessions SET context_project_id=next_project,context_compartments=next_labels WHERE id=sid;
   DELETE FROM public.conversation_settings_transitions WHERE transaction_id=pg_current_xact_id() AND session_id=sid;
  END IF;
  IF next_cap IS DISTINCT FROM e.cap THEN UPDATE public.sessions SET effective_clearance=next_cap WHERE id=sid;END IF;
  UPDATE public.conversation_envelopes SET visibility=next_visibility,cap=next_cap,compartments=next_labels,
   project_ids=next_projects,version=e.version+1,record_data_revision=record_data_revision+1,record_dirty_from=0 WHERE session_id=sid
   RETURNING version INTO published_version;
  DELETE FROM public.conversation_participants WHERE session_id=sid AND NOT user_id=ANY(next_participants);
  INSERT INTO public.conversation_participants(session_id,user_id)
   SELECT sid,u FROM unnest(next_participants) u ORDER BY u ON CONFLICT DO NOTHING;
  INSERT INTO public.conversation_visibility_audit(session_id,actor_user_id,previous_version,next_version,before_envelope,after_envelope)
   VALUES(sid,actor,e.version,published_version,before_state,
    public.conversation_authority_state(sid)) RETURNING id INTO audit_id;
  -- A private participant must be a current member meeting the new labels and
  -- its actual anchor under that participant's authority.
  FOREACH member_id IN ARRAY CASE WHEN operation='visibility' AND requested_participants IS NOT NULL THEN next_participants ELSE '{}'::uuid[] END LOOP
   IF public.conversation_member_read_allowed(w,sid,member_id) IS NOT TRUE
   THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  END LOOP;
  IF notice IS NOT NULL THEN
   INSERT INTO public.conversation_visibility_notices(session_id,audit_id,recipient_user_id,kind)
   SELECT sid,audit_id,u,notice FROM (
    SELECT DISTINCT u FROM unnest(current_participants||next_participants||e.starter_user_id) u
   ) audience;
  END IF;
  INSERT INTO public.conversation_visibility_notices(session_id,audit_id,recipient_user_id,kind)
   SELECT sid,audit_id,u,'participant_added' FROM unnest(participant_added) u;
 ELSE published_version:=e.version;END IF;
 metadata:=public.conversation_visibility_metadata_current(sid,actor);
 RETURN CASE WHEN metadata IS NULL THEN jsonb_build_object('committed',true,'readable',false,'sessionId',sid,
  'version',published_version,'code','conversation_access_denied')
 ELSE jsonb_build_object('committed',true,'readable',true,'sessionId',sid,'version',published_version,'metadata',metadata) END;
END $mutation$;
REVOKE ALL ON FUNCTION public.mutate_conversation_settings(uuid,uuid,integer,bigint,text,text,jsonb) FROM PUBLIC,app_user;

CREATE FUNCTION public.change_conversation_visibility(sid uuid,device uuid,native_version integer,expected_version bigint,visibility text,participants jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $visibility$
 SELECT public.mutate_conversation_settings(sid,device,native_version,expected_version,'visibility',visibility,participants)
$visibility$;
CREATE FUNCTION public.raise_conversation_cap(sid uuid,device uuid,native_version integer,expected_version bigint,cap text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $cap$
 SELECT public.mutate_conversation_settings(sid,device,native_version,expected_version,'cap',cap,NULL)
$cap$;
CREATE FUNCTION public.move_conversation_project(sid uuid,device uuid,native_version integer,expected_version bigint,project_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $project$
 SELECT public.mutate_conversation_settings(sid,device,native_version,expected_version,'project',project_id::text,NULL)
$project$;
CREATE FUNCTION public.promote_native_conversation_legacy_history(sid uuid,device uuid,native_version integer,expected_version bigint)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $promotion$
 SELECT public.mutate_conversation_settings(sid,device,native_version,expected_version,'legacy_promotion',NULL,NULL)
$promotion$;
REVOKE ALL ON FUNCTION public.change_conversation_visibility(uuid,uuid,integer,bigint,text,jsonb),
 public.raise_conversation_cap(uuid,uuid,integer,bigint,text),public.move_conversation_project(uuid,uuid,integer,bigint,uuid),
 public.promote_native_conversation_legacy_history(uuid,uuid,integer,bigint) FROM PUBLIC,app_user;
