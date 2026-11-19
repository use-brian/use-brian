-- [COMP:api/native-turn-frame] Durable completion header for every owned turn (8277).
-- One immutable row per owned turn: the owner's completion identity bound to its
-- session, lease token and answering assistant, written by the owner's reply
-- publication in the same transaction as the reply rows. It stores identities and
-- sequences only, never plaintext, and it is never an authorization or delivery
-- grant: readers re-check the session audience on every call.
CREATE TABLE public.native_turn_completions(
 id uuid PRIMARY KEY,
 workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 turn_token uuid NOT NULL,
 turn_id text,
 lane text NOT NULL,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 input_kind text,
 input_ref text,
 stopped boolean NOT NULL,
 published_reply boolean NOT NULL,
 outputs jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT native_turn_completion_turn UNIQUE(session_id,turn_token),
 CONSTRAINT native_turn_completion_lane CHECK(lane IN('web_shared','web_private','channel','public','callee','resume')),
 CONSTRAINT native_turn_completion_turn_id CHECK(turn_id~'^[a-f0-9]{64}$' AND workspace_id IS NOT NULL OR turn_id IS NULL AND workspace_id IS NULL),
 CONSTRAINT native_turn_completion_input CHECK(input_kind IS NULL AND input_ref IS NULL
  OR input_kind IN('session_message','approval','delegation') AND length(input_ref) BETWEEN 1 AND 200),
 CONSTRAINT native_turn_completion_outputs CHECK(jsonb_typeof(outputs)='array' AND jsonb_array_length(outputs) BETWEEN 1 AND 512),
 CONSTRAINT native_turn_completion_reply CHECK(NOT(stopped AND published_reply))
);
CREATE INDEX native_turn_completion_discovery ON public.native_turn_completions(session_id,input_kind,input_ref,created_at);
REVOKE ALL ON public.native_turn_completions FROM PUBLIC,app_user;
ALTER TABLE public.native_turn_completions ENABLE ROW LEVEL SECURITY;
INSERT INTO public.crm_erasure_journal_targets VALUES('native_turn_completions','{id}',false);
CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON public.native_turn_completions FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect();

-- The completion audience is exactly the session SELECT audience: either
-- permissive policy (personal owner or shared workspace member) AND both
-- restrictive policies (project scope, recording privacy hold). The owner pool is
-- the system recovery path and already reads every session; nothing is cached.
CREATE FUNCTION public.native_turn_completion_scope(w uuid,s uuid) RETURNS public.sessions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r public.sessions;system boolean;
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 system:=pg_has_role(session_user,(SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.sessions'::regclass),'USAGE');
 -- FOR SHARE waits for any in-flight publisher, which holds the session row lock
 -- from its completion record until COMMIT or ROLLBACK.
 SELECT * INTO r FROM public.sessions WHERE id=s FOR SHARE;
 IF NOT FOUND OR r.workspace_id IS DISTINCT FROM w THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF NOT system AND (nullif(current_setting('app.current_user_id',true),'') IS NULL OR r.recording_privacy_held
  OR NOT coalesce((session_personal_audience(r) OR session_workspace_audience(r)) AND session_project_audience(r,false),false))
 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 RETURN r;
END $body$;

-- Called once by the owner's reply publication, inside the same transaction and
-- after the reply rows. The lease token is the binding; every row must have been
-- written by this transaction. An exact duplicate returns the committed receipt;
-- any mismatch refuses.
CREATE FUNCTION public.record_native_turn_completion(w uuid,s uuid,t uuid,completion jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r public.sessions;existing public.native_turn_completions;stored public.native_turn_completions;state text;effective_stopped boolean;
 resolved_lane text;assistant uuid;operation uuid;kind text;ref text;rendered jsonb;matched integer;requested integer;last_content jsonb;reply boolean;
 top bigint;top_low bigint;system boolean;
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 system:=pg_has_role(session_user,(SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.sessions'::regclass),'USAGE');
 IF NOT system AND nullif(current_setting('app.current_user_id',true),'') IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 IF s IS NULL OR t IS NULL OR jsonb_typeof(completion) IS DISTINCT FROM 'object'
  OR completion-ARRAY['operationId','lane','assistantId','input','stopped','messages']<>'{}'
  OR NOT completion ?& ARRAY['operationId','lane','assistantId','input','stopped','messages']
  OR jsonb_typeof(completion->'operationId') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(completion->>'operationId','uuid')
  OR jsonb_typeof(completion->'assistantId') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(completion->>'assistantId','uuid')
  OR jsonb_typeof(completion->'lane') IS DISTINCT FROM 'string' OR NOT completion->>'lane'=ANY(ARRAY['web','channel','public','callee','resume'])
  OR jsonb_typeof(completion->'stopped') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(completion->'messages') IS DISTINCT FROM 'array' OR jsonb_array_length(completion->'messages') NOT BETWEEN 1 AND 512
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(completion->'messages') m WHERE jsonb_typeof(m) IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(m#>>'{}','uuid'))
  OR (SELECT count(DISTINCT (m#>>'{}')::uuid) FROM jsonb_array_elements(completion->'messages') m)<>jsonb_array_length(completion->'messages')
  OR NOT jsonb_typeof(completion->'input')=ANY(ARRAY['null','object'])
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 IF jsonb_typeof(completion->'input')='object' THEN
  kind:=completion#>>'{input,kind}';ref:=completion#>>'{input,ref}';
  IF (completion->'input')-ARRAY['kind','ref']<>'{}' OR jsonb_typeof(completion#>'{input,kind}') IS DISTINCT FROM 'string'
   OR jsonb_typeof(completion#>'{input,ref}') IS DISTINCT FROM 'string' OR NOT kind=ANY(ARRAY['session_message','approval','delegation'])
   OR length(ref) NOT BETWEEN 1 AND 200 OR kind<>'delegation' AND NOT pg_input_is_valid(ref,'uuid')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF kind<>'delegation' THEN ref:=ref::uuid::text;END IF;
 END IF;
 operation:=(completion->>'operationId')::uuid;assistant:=(completion->>'assistantId')::uuid;
 -- Same row lock as the reclaim/claim/Stop owner; the native publisher already holds it.
 SELECT * INTO r FROM public.sessions WHERE id=s FOR NO KEY UPDATE;
 IF NOT FOUND OR r.workspace_id IS DISTINCT FROM w THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF r.last_turn_lease_token IS DISTINCT FROM t THEN state:='superseded';
 ELSIF r.turn_lease_token=t AND r.status='running' THEN state:=CASE WHEN r.cancel_requested_at IS NULL THEN 'active' ELSE 'stopping' END;
 ELSIF r.turn_lease_token IS NULL AND r.turn_end_reason='stopped_by_user' THEN state:='stopped';
 ELSE state:='superseded';END IF;
 IF state='superseded' OR r.turn_assistant_id IS DISTINCT FROM assistant AND r.turn_assistant_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=assistant AND (w IS NULL OR a.workspace_id=w))
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 effective_stopped:=(completion->>'stopped')::boolean OR state IN('stopping','stopped');
 resolved_lane:=CASE completion->>'lane' WHEN 'web' THEN CASE WHEN r.visibility='workspace' THEN 'web_shared' ELSE 'web_private' END ELSE completion->>'lane' END;
 IF completion->>'lane'='web' AND r.channel_type<>'web' OR completion->>'lane'='channel' AND r.channel_type='web'
  OR kind='session_message' AND NOT EXISTS(SELECT 1 FROM public.session_messages m WHERE m.session_id=s AND m.id=ref::uuid AND m.role='user')
  OR kind='approval' AND NOT EXISTS(SELECT 1 FROM public.pending_approvals a WHERE a.id=ref::uuid AND a.workspace_id=r.workspace_id
   AND (a.blocking_session_id=s OR EXISTS(SELECT 1 FROM public.session_resume_points p WHERE p.session_id=s AND p.approval_id=a.id)))
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 -- A visible row whose creating (sub)transaction is still in progress was written
 -- by this transaction: other in-progress rows are invisible under MVCC.
 top:=pg_current_xact_id()::text::bigint;top_low:=top%4294967296;
 SELECT count(*),jsonb_agg(jsonb_build_object('id',m.id,'sequence',m.sequence_num,'role',m.role) ORDER BY m.sequence_num),
  (array_agg(m.content ORDER BY m.sequence_num DESC) FILTER(WHERE m.role='assistant'))[1]
 INTO matched,rendered,last_content
 FROM public.session_messages m
 WHERE m.session_id=s AND m.id IN(SELECT (e#>>'{}')::uuid FROM jsonb_array_elements(completion->'messages') e)
  AND m.role IN('assistant','user') AND (m.sender_assistant_id IS NULL OR m.sender_assistant_id=assistant)
  AND m.xmin::text::bigint>2 AND ((m.xmin::text::bigint-top_low)%4294967296+4294967296)%4294967296<2147483648
  AND pg_xact_status((top+((m.xmin::text::bigint-top_low)%4294967296+4294967296)%4294967296)::text::xid8)='in progress';
 requested:=jsonb_array_length(completion->'messages');
 IF matched<>requested OR last_content IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 reply:=NOT effective_stopped AND CASE jsonb_typeof(last_content)
  WHEN 'string' THEN length(btrim(last_content#>>'{}'))>0
  WHEN 'array' THEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(last_content) b WHERE b->>'type'='tool_use')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(last_content) b WHERE b->>'type'='text' AND length(btrim(coalesce(b->>'text','')))>0)
  ELSE false END;
 SELECT * INTO existing FROM public.native_turn_completions c WHERE c.session_id=s AND c.turn_token=t;
 IF FOUND THEN
  IF existing.id<>operation OR existing.lane<>resolved_lane OR existing.assistant_id<>assistant OR existing.outputs<>rendered
   OR existing.input_kind IS DISTINCT FROM kind OR existing.input_ref IS DISTINCT FROM ref OR existing.stopped<>effective_stopped
  THEN RAISE EXCEPTION 'turn_completion_conflict' USING ERRCODE='42501';END IF;
  stored:=existing;
 ELSE
  INSERT INTO public.native_turn_completions(id,workspace_id,session_id,turn_token,turn_id,lane,assistant_id,input_kind,input_ref,stopped,published_reply,outputs)
  VALUES(operation,w,s,t,public.native_session_public_turn_id(w,s,t),resolved_lane,assistant,kind,ref,effective_stopped,reply,rendered)
  RETURNING * INTO stored;
 END IF;
 RETURN jsonb_build_object('version',1,'duplicate',existing.id IS NOT NULL,'operationId',stored.id,'turnId',stored.turn_id,'lane',stored.lane,
  'assistantId',stored.assistant_id,'input',CASE WHEN stored.input_kind IS NULL THEN NULL ELSE jsonb_build_object('kind',stored.input_kind,'ref',stored.input_ref) END,
  'stopped',stored.stopped,'publishedReply',stored.published_reply,'outputs',stored.outputs,'createdAt',stored.created_at);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';
END $body$;

-- Reconciliation by the owner's lease token or by the turn's input. After the
-- session row lock: a visible row is committed; a token that can still publish
-- is in progress; a superseded token with no row did not commit and never can.
CREATE FUNCTION public.read_native_turn_completion(w uuid,s uuid,t uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE r public.sessions;kind text;ref text;items jsonb;live boolean;
BEGIN
 IF (t IS NULL)=(input IS NULL) THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 IF input IS NOT NULL THEN
  kind:=input->>'kind';ref:=input->>'ref';
  IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR input-ARRAY['kind','ref']<>'{}' OR jsonb_typeof(input->'kind') IS DISTINCT FROM 'string'
   OR jsonb_typeof(input->'ref') IS DISTINCT FROM 'string' OR NOT kind=ANY(ARRAY['session_message','approval','delegation'])
   OR length(ref) NOT BETWEEN 1 AND 200 OR kind<>'delegation' AND NOT pg_input_is_valid(ref,'uuid')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF kind<>'delegation' THEN ref:=ref::uuid::text;END IF;
 END IF;
 r:=native_turn_completion_scope(w,s);
 live:=r.turn_lease_token IS NOT NULL AND r.status='running';
 SELECT coalesce(jsonb_agg(jsonb_build_object('operationId',c.id,'turnId',c.turn_id,'lane',c.lane,'assistantId',c.assistant_id,
   'input',CASE WHEN c.input_kind IS NULL THEN NULL ELSE jsonb_build_object('kind',c.input_kind,'ref',c.input_ref) END,
   'stopped',c.stopped,'publishedReply',c.published_reply,'outputs',c.outputs,'createdAt',c.created_at) ORDER BY c.created_at DESC,c.id DESC),'[]')
 INTO items FROM(SELECT * FROM public.native_turn_completions c WHERE c.session_id=s
  AND (t IS NULL OR c.turn_token=t) AND (input IS NULL OR c.input_kind=kind AND c.input_ref=ref)
  ORDER BY c.created_at DESC,c.id DESC LIMIT 20) c;
 IF jsonb_array_length(items)>0 THEN RETURN jsonb_build_object('version',1,'state','committed','live',live,'completions',items);END IF;
 IF t IS NOT NULL AND r.last_turn_lease_token IS NOT DISTINCT FROM t
  AND (r.turn_lease_token=t AND r.status='running' OR r.turn_lease_token IS NULL AND r.turn_end_reason='stopped_by_user')
 THEN RETURN jsonb_build_object('version',1,'state','in_progress','live',live,'completions',items);END IF;
 RETURN jsonb_build_object('version',1,'state','not_committed','live',live,'completions',items);
EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';
END $body$;

CREATE FUNCTION public.native_turn_completion_immutable() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
BEGIN
 RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
END $body$;
CREATE TRIGGER native_turn_completion_immutable BEFORE UPDATE ON public.native_turn_completions
 FOR EACH ROW EXECUTE FUNCTION public.native_turn_completion_immutable();

REVOKE ALL ON FUNCTION public.native_turn_completion_scope(uuid,uuid),public.record_native_turn_completion(uuid,uuid,uuid,jsonb),
 public.read_native_turn_completion(uuid,uuid,uuid,jsonb),public.native_turn_completion_immutable() FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.record_native_turn_completion(uuid,uuid,uuid,jsonb),public.read_native_turn_completion(uuid,uuid,uuid,jsonb) TO app_user;
