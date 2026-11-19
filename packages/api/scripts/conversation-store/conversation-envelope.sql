-- [COMP:api/conversation-visibility] Additive foundation. Runtime activation is a
-- reviewed successor; no existing authenticated helper or identity key changes.
BEGIN;
DO $normalized_session_kind$ BEGIN
 IF EXISTS(SELECT 1 FROM public.sessions WHERE visibility NOT IN ('personal','workspace')
  OR anchor_kind IS NULL OR anchor_kind NOT IN ('none','doc_thread','office_file','feed_draft','feed_thread','channel','inbox','job'))
 THEN RAISE EXCEPTION 'conversation_kind_not_normalized'; END IF;
END $normalized_session_kind$;

CREATE TABLE conversation_envelopes (
 session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
 starter_user_id uuid NOT NULL REFERENCES users(id),
 visibility text NOT NULL CHECK (visibility IN ('private_by_kind','configured_private','workspace')),
 cap text NOT NULL CHECK (cap IN ('public','internal','confidential')),
 compartments text[] NOT NULL,
 project_ids uuid[] NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
 classified_at timestamptz NOT NULL DEFAULT now(),
 classification text NOT NULL CHECK(classification IN ('member_direct','legacy_personal','existing_workspace','new_public')),
 CHECK(workspace_id IS NOT NULL OR visibility <> 'workspace')
);
CREATE INDEX conversation_envelopes_workspace ON conversation_envelopes(workspace_id,session_id);

CREATE TABLE conversation_participants (
 session_id uuid NOT NULL REFERENCES conversation_envelopes(session_id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 added_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(session_id,user_id)
);
CREATE TABLE conversation_visibility_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL REFERENCES conversation_envelopes(session_id) ON DELETE CASCADE,
 actor_user_id uuid NOT NULL REFERENCES users(id),
 previous_version bigint NOT NULL,
 next_version bigint NOT NULL CHECK(next_version=previous_version+1),
 before_envelope jsonb NOT NULL,
 after_envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(session_id,next_version)
);
CREATE TABLE conversation_message_quarantine (
 session_id uuid NOT NULL REFERENCES conversation_envelopes(session_id) ON DELETE CASCADE,
 message_id uuid NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
 reason text NOT NULL CHECK(reason IN ('missing_stamp','above_cap','outside_boundary','private_owner')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(message_id,reason)
);

-- No app-user direct grant. The reviewed successor exposes canonical bounded
-- read/mutation functions after every protected consumer enforces the envelope.
ALTER TABLE conversation_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_visibility_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_message_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON conversation_envelopes,conversation_participants,
 conversation_visibility_audit,conversation_message_quarantine FROM PUBLIC;

CREATE FUNCTION classify_conversation_envelope(target uuid, historical boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.sessions; w uuid; assistant_cap text; chosen text; chosen_cap text; legacy_group boolean; member_now boolean;
BEGIN
 SELECT * INTO s FROM public.sessions WHERE id=target;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT workspace_id,clearance INTO w,assistant_cap FROM public.assistants WHERE id=s.assistant_id;
 w:=coalesce(s.workspace_id,w);
 -- A shared anchored thread is already workspace; a personal dock remains
 -- personal. Unknown personal shapes are never inferred to be shared.
 -- Only positive convergence evidence identifies a historical per-user group.
 -- Archived 1:1s and former members keep private-by-kind protection forever.
 legacy_group:=s.archived_at IS NOT NULL AND s.channel_type IN ('telegram','slack','discord','feishu','msteams','whatsapp','wechat','email','custom','imessage') AND EXISTS(SELECT 1 FROM public.sessions room JOIN public.assistants a ON a.id=room.assistant_id
  WHERE coalesce(room.workspace_id,a.workspace_id)=w AND room.visibility='workspace' AND room.anchor_kind='channel'
   AND room.channel_type=s.channel_type AND room.channel_id=s.channel_id AND room.id<>s.id);
 member_now:=EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=s.user_id);
 chosen:=/* CONVERSATION_VISIBILITY_CLASSIFICATION */;
 -- An established cap is never lowered. A legacy private NULL cap is not
 -- the answering assistant's current clearance: derive its actual retained
 -- admitted floor from complete in-boundary stamps, then the original owner's
 -- current membership for an empty conversation. Unknown rows are quarantined.
 chosen_cap:=s.effective_clearance;
 IF chosen_cap IS NULL THEN
  SELECT m.sensitivity INTO chosen_cap FROM public.session_messages m
   WHERE m.session_id=s.id AND m.workspace_id=w AND m.scope_held IS FALSE
    AND m.scope_version IS NOT NULL AND m.sensitivity IN ('public','internal','confidential')
    AND (m.user_id IS NULL OR chosen<>'workspace' AND m.user_id=s.user_id)
    AND m.compartments IS NOT NULL AND m.project_ids IS NOT NULL
    AND m.compartments <@ coalesce(s.context_compartments,ARRAY[]::text[])
    AND m.project_ids <@ CASE WHEN s.context_project_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[s.context_project_id] END
    AND NOT public.scope_review_state_held('session_message',m.id)
   ORDER BY public.sensitivity_rank(m.sensitivity) DESC LIMIT 1;
 END IF;
 IF chosen_cap IS NULL THEN
  SELECT clearance INTO chosen_cap FROM public.workspace_members WHERE workspace_id=w AND user_id=s.user_id;
 END IF;
 chosen_cap:=coalesce(chosen_cap,CASE WHEN w IS NULL THEN assistant_cap ELSE 'public' END,'public');
 IF chosen='workspace' AND NOT historical AND s.visibility<>'workspace' THEN chosen_cap:='public'; END IF;
 INSERT INTO public.conversation_envelopes(session_id,workspace_id,starter_user_id,visibility,cap,compartments,project_ids,classification)
 VALUES(s.id,w,s.user_id,chosen,
  chosen_cap,
  coalesce(s.context_compartments,ARRAY[]::text[]),
  CASE WHEN s.context_project_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[s.context_project_id] END,
  CASE WHEN chosen='private_by_kind' THEN 'member_direct' WHEN chosen='workspace' AND s.visibility='workspace' THEN 'existing_workspace'
   WHEN chosen='workspace' THEN 'new_public' ELSE 'legacy_personal' END)
 ON CONFLICT(session_id) DO NOTHING;
 IF NOT FOUND THEN RETURN false; END IF;
 -- The starter is implicit; do not invent participants from message senders.
 -- Existing held rows are untouched. Quarantine inventories invalid stamps
 -- without relabelling or triggering historical hold-release side effects.
 INSERT INTO public.conversation_message_quarantine(session_id,message_id,reason)
 SELECT s.id,m.id,r.reason FROM public.session_messages m
 JOIN public.conversation_envelopes e ON e.session_id=m.session_id
 CROSS JOIN LATERAL (SELECT CASE
   WHEN m.sensitivity IS NULL OR m.compartments IS NULL OR m.project_ids IS NULL THEN 'missing_stamp'
   WHEN m.user_id IS NOT NULL AND (e.visibility='workspace' OR m.user_id<>e.starter_user_id) THEN 'private_owner'
   WHEN public.sensitivity_rank(m.sensitivity)>public.sensitivity_rank(e.cap) THEN 'above_cap'
   WHEN NOT m.compartments <@ e.compartments OR NOT m.project_ids <@ e.project_ids THEN 'outside_boundary'
   ELSE NULL END AS reason) r
 WHERE m.session_id=s.id AND r.reason IS NOT NULL
 ON CONFLICT DO NOTHING;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION classify_conversation_envelope(uuid,boolean) FROM PUBLIC;

CREATE FUNCTION backfill_conversation_envelopes(batch_size integer DEFAULT 500) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item uuid; changed integer:=0;
BEGIN
 IF batch_size<1 OR batch_size>1000 THEN RAISE EXCEPTION 'conversation_backfill_batch_invalid'; END IF;
 -- Skip locked sessions allow independent product-owned maintenance runs;
 -- each call owns at most one bounded transaction and resumes by missing key.
 FOR item IN SELECT s.id FROM public.sessions s
  WHERE NOT EXISTS(SELECT 1 FROM public.conversation_envelopes e WHERE e.session_id=s.id)
  ORDER BY s.id LIMIT batch_size FOR UPDATE OF s SKIP LOCKED LOOP
  IF public.classify_conversation_envelope(item,true) THEN changed:=changed+1; END IF;
 END LOOP;
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION backfill_conversation_envelopes(integer) FROM PUBLIC;

CREATE FUNCTION initialize_conversation_envelope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.classify_conversation_envelope(NEW.id,false);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION initialize_conversation_envelope() FROM PUBLIC;
CREATE TRIGGER zzzz_conversation_envelope AFTER INSERT ON sessions
 FOR EACH ROW EXECUTE FUNCTION initialize_conversation_envelope();

-- Default privileges may grant app_user or another installed role EXECUTE.
-- Remove every non-owner grant explicitly, not just PUBLIC. Triggers invoke
-- their function as owner; no caller can choose historical=false for old data.
DO $envelope_acl$
DECLARE item record; granted record;
BEGIN
 FOR item IN SELECT p.oid,p.proowner,p.oid::regprocedure AS signature FROM pg_proc p
  WHERE p.oid IN ('public.classify_conversation_envelope(uuid,boolean)'::regprocedure,
   'public.backfill_conversation_envelopes(integer)'::regprocedure,
   'public.initialize_conversation_envelope()'::regprocedure) LOOP
  FOR granted IN SELECT DISTINCT x.grantee FROM pg_proc p,
   LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
   WHERE p.oid=item.oid AND x.grantee<>item.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',item.signature,
    CASE WHEN granted.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(granted.grantee)) END);
  END LOOP;
 END LOOP;
 FOR item IN SELECT c.oid,c.relowner,c.oid::regclass AS relation FROM pg_class c
  WHERE c.oid IN ('public.conversation_envelopes'::regclass,'public.conversation_participants'::regclass,
   'public.conversation_visibility_audit'::regclass,'public.conversation_message_quarantine'::regclass) LOOP
  FOR granted IN SELECT DISTINCT x.grantee FROM pg_class c,
   LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   WHERE c.oid=item.oid AND x.grantee<>item.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s FROM %s',item.relation,
    CASE WHEN granted.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(granted.grantee)) END);
  END LOOP;
 END LOOP;
END $envelope_acl$;

-- Backfill is intentionally not run as an unbounded migration transaction.
-- Activation requires the maintained bounded worker to drain missing keys and
-- qualify the inventory. Before activation the existing 8294 readers remain.
COMMIT;
