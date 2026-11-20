-- [COMP:api/turn-kernel] Canonical original-token transition owner.
CREATE FUNCTION public.native_session_public_turn_id(w uuid,s uuid,t uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
BEGIN
 RETURN CASE WHEN w IS NULL OR s IS NULL OR t IS NULL THEN NULL ELSE
  encode(sha256(convert_to('use-brian/session-turn/v1:'||w::text||':'||s::text||':'||t::text,'UTF8')),'hex') END;
END $body$;

-- Private immutable-metadata classifier. Call only after locking the exact
-- current session owner; it never reads source graphs or protected content.
CREATE FUNCTION public.native_session_expired_turn_outcome(w uuid,s uuid,t uuid,a uuid,cancelled boolean)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE publication public.native_conversation_publications;
BEGIN
 IF cancelled THEN RETURN 'stopped_by_user';END IF;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
 IF w IS NULL OR t IS NULL OR a IS NULL THEN RETURN 'stalled_reclaimed';END IF;
 SELECT * INTO publication FROM public.native_conversation_publications p
  WHERE p.workspace_id=w AND p.session_id=s AND p.turn_token=t
   AND p.slot='buffered_transcript';
 IF NOT FOUND OR publication.command_format=1 THEN RETURN 'stalled_reclaimed';END IF;
 IF publication.command_format<>2 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
 IF publication.completed_at IS NULL OR publication.outputs IS NULL OR jsonb_typeof(publication.outputs) IS DISTINCT FROM 'array'
  OR jsonb_array_length(publication.outputs)<>publication.expected_output_count
 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
 IF publication.assistant_id<>a OR publication.stopped OR publication.terminal_descriptor IS NULL THEN RETURN 'stalled_reclaimed';END IF;
 IF publication.outputs IS NULL OR publication.terminal_outputs IS NULL
  OR jsonb_typeof(publication.terminal_outputs) IS DISTINCT FROM 'array'
  OR jsonb_array_length(publication.terminal_outputs)=0
  OR jsonb_array_length(publication.terminal_outputs)<>jsonb_array_length(publication.terminal_descriptor->'members')
 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
 -- The authenticated independent completion owner validates descriptor/member
 -- shape, exact roots/native references and the entire actual output closure
 -- before this immutable row can commit. Current access does not alter that fact.
 RETURN 'publication_recovered';
END $body$;

-- One lock/fresh-read owner for claim, explicit reclaim and Stop capture.
-- This does not authorize the requesting user; the existing route/read owner
-- remains mandatory. It is callable only by the existing private owner pool.
CREATE FUNCTION public.native_session_turn_transition(
 s uuid,action text,answering_assistant uuid,started_at timestamp with time zone,
 stale_after_ms integer,expected_token uuid,expected_public_turn_id text,fence_token boolean
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r public.sessions;w uuid;original_token uuid;original_public_id text;outcome text;
 recovered jsonb;next_token uuid;resting text;now_at timestamptz;
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
 IF action IS NULL OR action NOT IN('claim','reclaim','cancel') OR stale_after_ms IS NULL OR stale_after_ms<1
  OR fence_token IS NULL OR current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'invalid_turn_transition' USING ERRCODE='22023';END IF;
 SELECT workspace_id INTO w FROM public.sessions WHERE id=s;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- Same order as canonical native publication, never session then workspace.
 IF w IS NOT NULL THEN
  PERFORM id FROM public.workspaces WHERE id=w FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN NULL;END IF;
 END IF;
 -- VOLATILE PL/pgSQL uses a new READ COMMITTED snapshot here after lock wait.
 SELECT * INTO r FROM public.sessions WHERE id=s FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.workspace_id IS DISTINCT FROM w THEN RAISE EXCEPTION 'turn_scope_changed' USING ERRCODE='40001';END IF;
 now_at:=clock_timestamp();original_token:=r.turn_lease_token;
 original_public_id:=public.native_session_public_turn_id(w,s,original_token);
 IF fence_token AND original_token IS DISTINCT FROM expected_token
  OR expected_public_turn_id IS NOT NULL AND original_public_id IS DISTINCT FROM expected_public_turn_id
 THEN RETURN jsonb_build_object('state','superseded');END IF;
 IF action='cancel' THEN
  IF r.status<>'running' THEN RETURN jsonb_build_object('state','not_running');END IF;
  IF original_token IS NULL THEN
   UPDATE public.sessions SET status='idle',turn_heartbeat_at=NULL,cancel_requested_at=NULL,turn_end_reason='stopped_by_user',last_active_at=now_at WHERE id=s;
   RETURN jsonb_build_object('state','stopped_legacy','turnId',NULL,'reason','stopped_by_user');
  END IF;
  UPDATE public.sessions SET cancel_requested_at=coalesce(cancel_requested_at,now_at)
   WHERE id=s AND turn_lease_token=original_token AND status='running';
  RETURN jsonb_build_object('state','cancel_requested','token',original_token,'turnId',original_public_id,
   'stale',coalesce(r.turn_heartbeat_at,r.last_active_at)<now_at-make_interval(secs=>stale_after_ms/1000.0));
 END IF;
 IF r.status='running' THEN
  IF coalesce(r.turn_heartbeat_at,r.last_active_at)>=now_at-make_interval(secs=>stale_after_ms/1000.0)
  THEN RETURN jsonb_build_object('state','busy');END IF;
  outcome:=public.native_session_expired_turn_outcome(r.workspace_id,r.id,r.turn_lease_token,
   CASE WHEN r.last_turn_lease_token=r.turn_lease_token THEN r.turn_assistant_id END,r.cancel_requested_at IS NOT NULL);
  resting:=CASE WHEN outcome IN('publication_recovered','stopped_by_user') THEN 'idle' ELSE 'timeout' END;
  UPDATE public.sessions SET status=resting,turn_lease_token=NULL,turn_heartbeat_at=NULL,cancel_requested_at=NULL,
   turn_end_reason=outcome,last_active_at=now_at WHERE id=s;
  recovered:=jsonb_build_object('turnId',original_public_id,'reason',outcome);
 ELSIF action='reclaim' THEN RETURN jsonb_build_object('state','not_running');
 END IF;
 IF action='reclaim' THEN RETURN jsonb_build_object('state','recovered','recovered',recovered);END IF;
 next_token:=gen_random_uuid();
 UPDATE public.sessions SET status='running',last_active_at=now_at,turn_lease_token=next_token,
  turn_started_at=coalesce(started_at,now_at),turn_heartbeat_at=now_at,cancel_requested_at=NULL,
  turn_end_reason=NULL,turn_assistant_id=answering_assistant WHERE id=s;
 RETURN jsonb_build_object('state','claimed','token',next_token,
  'turnId',public.native_session_public_turn_id(w,s,next_token),'recovered',recovered);
END $body$;

-- Release is token-specific and Stop wins even if a remote holder finishes
-- before its next heartbeat has delivered the cancellation to local JS.
CREATE FUNCTION public.native_session_release_turn(s uuid,t uuid,requested_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r public.sessions;w uuid;reason text;
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'terminal_control_unavailable' USING ERRCODE='55000';END IF;
 IF t IS NULL OR requested_reason IS NULL OR requested_reason NOT IN('completed','failed','stopped_by_user','stalled_reclaimed','timeout')
 THEN RAISE EXCEPTION 'invalid_turn_release' USING ERRCODE='22023';END IF;
 SELECT workspace_id INTO w FROM public.sessions WHERE id=s;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF w IS NOT NULL THEN PERFORM id FROM public.workspaces WHERE id=w FOR NO KEY UPDATE;END IF;
 SELECT * INTO r FROM public.sessions WHERE id=s FOR UPDATE;
 IF NOT FOUND OR r.status<>'running' OR r.turn_lease_token IS DISTINCT FROM t THEN RETURN NULL;END IF;
 IF r.workspace_id IS DISTINCT FROM w THEN RAISE EXCEPTION 'turn_scope_changed' USING ERRCODE='40001';END IF;
 reason:=CASE WHEN r.cancel_requested_at IS NOT NULL THEN 'stopped_by_user' ELSE requested_reason END;
 UPDATE public.sessions SET status=CASE WHEN reason='failed' THEN 'failed' WHEN reason IN('completed','stopped_by_user','publication_recovered') THEN 'idle' ELSE 'timeout' END,
  turn_lease_token=NULL,turn_heartbeat_at=NULL,cancel_requested_at=NULL,turn_end_reason=reason,last_active_at=clock_timestamp()
  WHERE id=s AND turn_lease_token=t;
 RETURN jsonb_build_object('turnId',public.native_session_public_turn_id(w,s,t),'reason',reason);
END $body$;

REVOKE ALL ON FUNCTION public.native_session_public_turn_id(uuid,uuid,uuid),
 public.native_session_expired_turn_outcome(uuid,uuid,uuid,uuid,boolean),
 public.native_session_turn_transition(uuid,text,uuid,timestamp with time zone,integer,uuid,text,boolean),
 public.native_session_release_turn(uuid,uuid,text) FROM PUBLIC,app_user;
