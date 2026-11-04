-- [COMP:api/session-legacy-history] Recorded-owner historical display only.
BEGIN;
SET LOCAL timezone='UTC';
CREATE FUNCTION private_legacy_history_binding(s sessions) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_array(s.id,s.user_id,s.assistant_id,s.workspace_id,s.visibility,
  s.channel_type,s.channel_id,s.app_origin,s.anchor_kind,s.mode,s.context_group_id,
  s.context_project_id,s.context_compartments,s.effective_clearance,s.context_binding_origin)
$$;
REVOKE ALL ON FUNCTION private_legacy_history_binding(sessions) FROM PUBLIC;

CREATE TABLE session_legacy_history (
 session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 binding jsonb NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE session_legacy_history_messages (
 session_id uuid NOT NULL REFERENCES session_legacy_history(session_id) ON DELETE CASCADE,
 message_id uuid PRIMARY KEY REFERENCES session_messages(id) ON DELETE CASCADE,
 sequence_num integer NOT NULL,
 fingerprint text NOT NULL,
 UNIQUE(session_id,sequence_num)
);
ALTER TABLE session_legacy_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_legacy_history_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON session_legacy_history,session_legacy_history_messages FROM PUBLIC;

-- Freeze the existing cohort once. Browsing never manufactures a receipt.
INSERT INTO session_legacy_history(session_id,user_id,workspace_id,binding)
 SELECT s.id,s.user_id,a.workspace_id,private_legacy_history_binding(s)
 FROM sessions s JOIN assistants a ON a.id=s.assistant_id
 JOIN workspace_members wm ON wm.workspace_id=a.workspace_id AND wm.user_id=s.user_id
 WHERE s.workspace_id IS NULL AND a.workspace_id IS NOT NULL
  AND s.visibility='personal' AND s.channel_type='web' AND s.anchor_kind='none'
  AND s.mode IS NULL
  AND s.context_binding_origin='legacy' AND s.context_compartments IS NOT NULL
  AND NOT s.recording_privacy_held;
INSERT INTO session_legacy_history_messages(session_id,message_id,sequence_num,fingerprint)
 SELECT m.session_id,m.id,m.sequence_num,encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex')
 FROM session_messages m JOIN session_legacy_history h ON h.session_id=m.session_id;

CREATE FUNCTION guard_private_legacy_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'legacy_history_immutable' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION guard_private_legacy_history() FROM PUBLIC;
CREATE TRIGGER private_legacy_history_immutable BEFORE INSERT OR UPDATE ON session_legacy_history
 FOR EACH ROW EXECUTE FUNCTION guard_private_legacy_history();
CREATE TRIGGER private_legacy_messages_immutable BEFORE INSERT OR UPDATE ON session_legacy_history_messages
 FOR EACH ROW EXECUTE FUNCTION guard_private_legacy_history();

CREATE FUNCTION read_private_legacy_history(w uuid,i uuid,device uuid,version integer,after_sequence integer,page_size integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 parent jsonb; receipt session_legacy_history; s sessions; item record; envelope jsonb;
 readable boolean; result jsonb:='[]'; next_sequence integer:=NULL; more boolean:=false; seen integer:=0;
BEGIN
 IF after_sequence<0 OR page_size<1 OR page_size>100 OR after_sequence IS NULL OR page_size IS NULL THEN
  RAISE EXCEPTION 'invalid_legacy_history' USING ERRCODE='22023'; END IF;
 -- This existing metadata port enforces non-owner role, native credential,
 -- actual owner/member/assistant and current explicit context authority under locks.
 parent:=read_native_session_recovery_parent(w,i,device,version);
 SELECT * INTO receipt FROM session_legacy_history WHERE session_id=i AND user_id=actor AND workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'legacy_history_unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM sessions WHERE id=i;
 IF private_legacy_history_binding(s) IS DISTINCT FROM receipt.binding
  OR scope_review_state_held('session',i) IS TRUE THEN
  RAISE EXCEPTION 'legacy_history_unavailable' USING ERRCODE='42501'; END IF;
 FOR item IN
  SELECT m.*,h.fingerprint,h.sequence_num AS frozen_sequence FROM session_legacy_history_messages h
  JOIN session_messages m ON m.id=h.message_id AND m.session_id=h.session_id
  WHERE h.session_id=i AND h.sequence_num>after_sequence
  ORDER BY h.sequence_num LIMIT page_size+1 FOR SHARE OF m
 LOOP
  seen:=seen+1;
  IF seen>page_size THEN more:=true;EXIT;END IF;
  next_sequence:=item.frozen_sequence;
  readable:=encode(sha256(convert_to((to_jsonb(item)-ARRAY['fingerprint','frozen_sequence'])::text,'UTF8')),'hex')=item.fingerprint
   AND item.role IN('user','assistant') AND item.scope_held IS NOT TRUE
   AND (item.workspace_id IS NULL OR item.workspace_id=w)
   AND (item.user_id IS NULL OR item.user_id=actor)
   AND (item.sender_user_id IS NULL OR item.sender_user_id=actor)
   AND scope_review_state_held('session_message',item.id) IS NOT TRUE
   AND NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.resource_kind='session_message' AND d.resource_id=item.id)
   AND NOT EXISTS(SELECT 1 FROM scope_resource_states r WHERE r.resource_kind='session_message' AND r.resource_id=item.id)
   AND octet_length(item.content::text)<=131072;
  -- Fully absent old envelopes are the display exception. Partial envelopes
  -- and known scoped rows must not be converted into an unclassified grant.
  IF readable AND (item.workspace_id IS NOT NULL OR item.user_id IS NOT NULL OR item.assistant_id IS NOT NULL OR item.sensitivity IS NOT NULL
    OR item.compartments IS NOT NULL OR item.project_ids IS NOT NULL OR item.scope_version IS NOT NULL) THEN
   envelope:=jsonb_build_object('workspaceId',item.workspace_id,'userId',item.user_id,
    'assistantId',item.assistant_id,'sensitivity',item.sensitivity,
    'compartments',item.compartments,'projectIds',item.project_ids);
   readable:=workflow_evidence_envelope_visible(w,envelope) IS TRUE;
  END IF;
  result:=result||jsonb_build_array(jsonb_build_object('id',item.id,'sequence',item.frozen_sequence,
   'role',CASE WHEN item.role IN('user','assistant') THEN item.role ELSE 'assistant' END,
   'timestamp',item.created_at,'available',coalesce(readable,false),
   'content',CASE WHEN readable THEN item.content ELSE NULL END));
 END LOOP;
 -- Recheck clock-dependent native authority after the bounded read too.
 PERFORM read_native_session_recovery_parent(w,i,device,version);
 RETURN jsonb_build_object('sessionId',i,'workspaceId',w,'mode','private_legacy_history',
  'rows',result,'nextSequence',CASE WHEN more THEN next_sequence ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION read_private_legacy_history(uuid,uuid,uuid,integer,integer,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON session_legacy_history,session_legacy_history_messages FROM app_user;
 GRANT EXECUTE ON FUNCTION read_private_legacy_history(uuid,uuid,uuid,integer,integer,integer) TO app_user;
END IF;END $$;
COMMIT;
