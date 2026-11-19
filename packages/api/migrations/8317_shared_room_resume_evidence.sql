-- [COMP:brain/session-resume-worker] Current evidence of a leased shared web
-- room continuation. Stored same-room record edges use the M7 edge owner.
BEGIN;

DO $shared_room_resume_predecessor$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8316_conversation_mixed_evidence_route.sql')
  OR public.native_turn_helpers_current() IS NOT TRUE
  OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 THEN RAISE EXCEPTION 'shared_room_resume_evidence_predecessor_changed'; END IF;
END $shared_room_resume_predecessor$;

CREATE FUNCTION public.lock_shared_room_resume_evidence(
 w uuid, actor uuid, answering uuid, sid uuid, channel text, approval uuid, lease uuid, roots jsonb, writing boolean
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $resume_evidence$
DECLARE
 room public.sessions; assistant_clearance text; graph jsonb; edges jsonb; node record; source jsonb;
 current_sources jsonb:='[]'; revisions jsonb:='[]'; edge_count integer;
BEGIN
 IF actor IS NULL OR actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
  OR actor IS DISTINCT FROM nullif(current_setting('app.agent_actor_id',true),'')::uuid
  OR w IS DISTINCT FROM nullif(current_setting('app.agent_workspace_id',true),'')::uuid
  OR answering IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')::uuid
  OR current_setting('app.agent_shared_audience',true) IS DISTINCT FROM 'true'
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR writing IS NULL
  OR public.native_turn_helpers_current() IS NOT TRUE
  OR jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096
  OR EXISTS(SELECT 1 FROM jsonb_to_recordset(roots) AS n(kind text,id uuid,version text)
    WHERE n.kind IS NULL OR n.kind NOT IN('session_message','session_context_revision')
    OR n.id IS NULL OR n.version IS NULL)
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;

 -- Keep the native principal lock order. The stored writer owns the
 -- stronger destination locks from proof through append and completion.
 PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
 PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 SELECT coalesce(a.clearance,'internal') INTO assistant_clearance FROM public.assistants a
 WHERE a.workspace_id=w AND a.id=answering AND NOT actor=ANY(a.blocked_user_ids)
  AND public.assistant_placement_visible(actor,a.id) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 IF writing THEN
  PERFORM id FROM public.sessions WHERE workspace_id=w AND id=sid FOR UPDATE;
  PERFORM session_id FROM public.conversation_envelopes WHERE workspace_id=w AND session_id=sid FOR UPDATE;
 END IF;
 IF public.lock_conversation_member_read(w,sid,actor) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 SELECT * INTO room FROM public.sessions s WHERE s.workspace_id=w AND s.id=sid;
 IF NOT FOUND OR room.user_id IS DISTINCT FROM actor OR room.assistant_id IS DISTINCT FROM answering
  OR room.channel_type<>'web' OR room.anchor_kind<>'none' OR room.visibility<>'workspace'
  OR room.app_origin IS DISTINCT FROM 'chat' OR room.transient IS TRUE
  OR room.channel_id IS DISTINCT FROM channel
  OR assistant_clearance<>coalesce(room.effective_clearance,'internal')
  OR lease IS NULL OR room.status<>'running' OR room.turn_lease_token IS DISTINCT FROM lease
  OR room.last_turn_lease_token IS DISTINCT FROM lease
  OR coalesce(room.turn_assistant_id,room.assistant_id) IS DISTINCT FROM answering
  OR room.cancel_requested_at IS NOT NULL
  OR room.turn_heartbeat_at IS NULL OR room.turn_heartbeat_at<=clock_timestamp()-interval '90 seconds'
  OR public.scope_review_state_held('session',sid)
  OR NOT EXISTS(SELECT 1 FROM public.conversation_envelopes e
    WHERE e.workspace_id=w AND e.session_id=sid AND e.visibility='workspace')
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.session_resume_points p JOIN public.pending_approvals a ON a.id=p.approval_id
  WHERE p.session_id=sid AND a.id=approval AND a.workspace_id=w AND a.approver_user_id=actor
   AND a.blocking_session_id=sid AND a.originating_assistant_id=answering
   AND a.kind IN('question','tool_invocation')
   AND a.status IN('approved','rejected','expired') FOR SHARE OF p,a;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;

 -- Keep every original edge, including where each record entered the graph.
 -- For this closed family, a row, revision or record from another room
 -- cannot qualify even when this actor can independently read both rooms.
 WITH RECURSIVE closure(kind,id,version) AS (
  SELECT r.kind,r.id,r.version FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
  UNION
  SELECT e.kind,e.id,e.version FROM closure c
  CROSS JOIN LATERAL public.conversation_source_edges(w,c.kind,c.id,c.version) e
  WHERE c.kind IN('session_message','session_context_revision')
 ), bounded AS MATERIALIZED (SELECT * FROM closure LIMIT 4097)
 SELECT jsonb_agg(to_jsonb(n)) INTO edges FROM bounded n;
 IF jsonb_array_length(edges)>4096 OR EXISTS(
  SELECT 1 FROM jsonb_to_recordset(edges) AS n(kind text,id uuid,version text)
  WHERE n.version IS NULL OR NOT CASE n.kind
   WHEN 'session_message' THEN EXISTS(SELECT 1 FROM public.session_messages m
    WHERE m.workspace_id=w AND m.session_id=sid AND m.id=n.id AND m.scope_version::text=n.version)
   WHEN 'session_context_revision' THEN EXISTS(SELECT 1 FROM public.session_context_scope_revisions r
    WHERE r.workspace_id=w AND r.session_id=sid AND r.id=n.id AND r.scope_version::text=n.version)
   WHEN 'conversation_record' THEN n.version='1' AND EXISTS(SELECT 1 FROM public.private_transcript_observations o
    WHERE o.workspace_id=w AND o.session_id=sid AND o.id=n.id AND o.binding->>'kind'='conversation_record_v1'
     AND o.binding->>'purpose'='native_member_dialogue')
   ELSE false END
 ) THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;

 edge_count:=0;
 FOR node IN SELECT d.id,s.source_id,s.source_version FROM jsonb_to_recordset(edges) AS n(kind text,id uuid)
  JOIN public.scope_derivations d ON d.workspace_id=w AND d.resource_kind=n.kind AND d.resource_id=n.id
  JOIN public.scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE n.kind IN('session_message','session_context_revision') AND s.source_kind='conversation_record'
  ORDER BY d.id,s.source_id LIMIT 65537
 LOOP
  edge_count:=edge_count+1;
  IF edge_count>65536 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501'; END IF;
  PERFORM public.require_conversation_record_edge(w,node.id,node.source_id,node.source_version);
 END LOOP;

 -- The native graph owns acyclicity, current row/parent snapshots, all-version
 -- recording privacy, archive rules and dependency validation. M7 record
 -- edges were positively checked above; they never become new input roots.
 graph:=public.conversation_dag(w,roots,'[]');
 IF graph->>'recordingEligible' IS DISTINCT FROM 'true' OR graph->>'hasExternal' IS DISTINCT FROM 'false'
  OR clock_timestamp()>=(graph->>'validUntil')::timestamptz
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 FOR node IN SELECT * FROM jsonb_to_recordset(edges) AS n(kind text,id uuid,version text)
  WHERE n.kind<>'conversation_record' LOOP
  source:=graph#>ARRAY['current',node.kind||':'||node.id||':'||node.version];
  IF (graph#>>ARRAY['native:'||node.kind||':'||node.id||':'||node.version,'value']) IS DISTINCT FROM 'true'
   OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM node.version
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  source:=source-ARRAY['held','validTo','retractedAt','requiredSources'];
  current_sources:=current_sources||jsonb_build_array(source);
  IF node.kind='session_context_revision' THEN revisions:=revisions||jsonb_build_array(source); END IF;
 END LOOP;
 IF public.native_turn_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('immutable',revisions,'current',current_sources);
END $resume_evidence$;
REVOKE ALL ON FUNCTION public.lock_shared_room_resume_evidence(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,boolean)
 FROM PUBLIC,app_user;

CREATE FUNCTION public.capture_shared_room_resume_evidence(
 w uuid, actor uuid, answering uuid, sid uuid, channel text, approval uuid, lease uuid, roots jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $capture$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
    WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN public.lock_shared_room_resume_evidence(w,actor,answering,sid,channel,approval,lease,roots,false);
END $capture$;
REVOKE ALL ON FUNCTION public.capture_shared_room_resume_evidence(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_shared_room_resume_evidence(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb) TO app_user;

COMMIT;
