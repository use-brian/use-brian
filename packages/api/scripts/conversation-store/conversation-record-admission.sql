-- [COMP:api/conversation-visibility] The native record frame is owned by the
-- original workspace member, device, answering assistant and durable turn.
-- It admits only record roots and never expands historical source edges.
CREATE FUNCTION public.conversation_record_turn_facts(w uuid, actor uuid, answering uuid, sid uuid,
 device uuid, native_version integer, credential_actor uuid, include_departments boolean,
 include_policy boolean, token uuid, boundary text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $facts$
DECLARE s public.sessions;e public.conversation_envelopes;a public.assistants;
BEGIN
 IF actor IS NULL OR actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
  OR actor IS DISTINCT FROM credential_actor OR token IS NULL
  OR include_departments IS NULL OR include_policy IS NULL
  OR boundary IS NULL OR boundary NOT IN('history','dispatch','frame','publication','stopped_publication')
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
    WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;

 PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 PERFORM device_row.id FROM public.auth_sessions device_row JOIN public.users u ON u.id=device_row.user_id
  WHERE device_row.id=device AND device_row.user_id=actor AND device_row.auth_version=native_version
   AND u.auth_version=native_version AND device_row.revoked_at IS NULL AND device_row.expires_at>clock_timestamp()
  FOR SHARE OF device_row,u;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public.assistants WHERE id=answering AND workspace_id=w FOR SHARE;
 IF NOT FOUND OR public.assistant_placement_visible(actor,answering) IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;

 SELECT * INTO s FROM public.sessions WHERE id=sid FOR SHARE;
 IF NOT FOUND OR s.last_turn_lease_token IS DISTINCT FROM token
  OR coalesce(s.turn_assistant_id,s.assistant_id) IS DISTINCT FROM answering
  OR (
   s.turn_lease_token IS NOT DISTINCT FROM token AND s.status='running'
    AND s.turn_heartbeat_at>clock_timestamp()-interval '90 seconds'
    AND (s.cancel_requested_at IS NULL OR boundary='stopped_publication')
   OR boundary='stopped_publication' AND s.turn_lease_token IS NULL AND s.turn_end_reason='stopped_by_user'
  ) IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 IF s.workspace_id IS DISTINCT FROM w AND (s.workspace_id IS NOT NULL OR s.user_id IS DISTINCT FROM actor
  OR s.assistant_id IS DISTINCT FROM answering OR boundary IN('publication','stopped_publication')
  OR (boundary='history' AND public.enroll_conversation_legacy_history(sid) IS NOT TRUE)
  OR public.conversation_legacy_enrolled(sid,w,actor,answering) IS NOT TRUE)
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 -- Acquisition already takes UPDATE to maintain the capture watermark.
 -- Taking it here avoids upgrading a SHARE lock under two readers.
 IF boundary='history' THEN
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id=w FOR UPDATE;
 ELSE
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id=w FOR SHARE;
 END IF;
 IF NOT FOUND OR public.sensitivity_rank(a.clearance)<public.sensitivity_rank(e.cap)
  OR public.conversation_member_read_current(w,sid,actor) IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object(
  'authority',public.read_session_authority_facts(w,actor,answering,sid,device,native_version,credential_actor,include_departments,include_policy),
  'destination',jsonb_build_object('sensitivity',e.cap,'compartments',e.compartments,
   'projectIds',public.conversation_hard_project_ids(e.compartments),'generation',e.version::text));
END $facts$;
REVOKE ALL ON FUNCTION public.conversation_record_turn_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,text) FROM PUBLIC,app_user;

CREATE FUNCTION public.capture_native_turn_conversation_record(w uuid, actor uuid, answering uuid, sid uuid,
 device uuid, native_version integer, credential_actor uuid, include_departments boolean,
 include_policy boolean, token uuid, after_sequence integer, through_sequence integer, topic_through integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $history$
DECLARE facts jsonb;high integer;
BEGIN
 facts:=public.conversation_record_turn_facts(w,actor,answering,sid,device,native_version,credential_actor,
  include_departments,include_policy,token,'history');
 SELECT coalesce(max(sequence_num),0) INTO high FROM public.session_messages WHERE session_id=sid;
 through_sequence:=coalesce(through_sequence,high);
 topic_through:=coalesce(topic_through,through_sequence);
 after_sequence:=least(after_sequence,through_sequence);
 RETURN facts || jsonb_build_object('record',public.capture_conversation_record_current(w,sid,after_sequence,through_sequence,topic_through));
END $history$;
REVOKE ALL ON FUNCTION public.capture_native_turn_conversation_record(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,integer,integer,integer) FROM PUBLIC,app_user;

CREATE FUNCTION public.admit_native_turn_conversation_records(w uuid, actor uuid, answering uuid, sid uuid,
 device uuid, native_version integer, credential_actor uuid, include_departments boolean,
 include_policy boolean, token uuid, boundary text, capture_ids uuid[], capture_versions text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $admission$
DECLARE facts jsonb;admitted jsonb;
BEGIN
 IF boundary NOT IN('dispatch','frame','publication','stopped_publication') OR capture_ids IS NULL
  OR capture_versions IS NULL OR cardinality(capture_ids) NOT BETWEEN 1 AND 4096
  OR cardinality(capture_ids)<>cardinality(capture_versions) OR array_position(capture_ids,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(capture_versions) v WHERE v IS DISTINCT FROM '1')
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 facts:=public.conversation_record_turn_facts(w,actor,answering,sid,device,native_version,credential_actor,
  include_departments,include_policy,token,boundary);
 WITH proven AS MATERIALIZED(
  SELECT ids.ord,public.read_conversation_record_source(w,o.id) AS snapshot
  FROM unnest(capture_ids) WITH ORDINALITY ids(id,ord)
  JOIN public.private_transcript_observations o ON o.workspace_id=w AND o.session_id=sid AND o.id=ids.id
  WHERE o.binding->>'kind'='conversation_record_v1' AND o.binding->>'purpose'='native_member_dialogue'
   AND o.binding->>'readerUserId'=actor::text AND o.binding->>'generation'=facts#>>'{destination,generation}'
 )
 SELECT jsonb_agg(snapshot-ARRAY['held','validTo','retractedAt'] ORDER BY ord) INTO admitted
 FROM proven WHERE snapshot->>'held'='false';
 IF coalesce(jsonb_array_length(admitted),0)<>cardinality(capture_ids)
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN facts || jsonb_build_object('records',admitted);
END $admission$;
REVOKE ALL ON FUNCTION public.admit_native_turn_conversation_records(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,text,uuid[],text[]) FROM PUBLIC,app_user;
-- Installation grants the two native wrappers after the complete roster verifies.
