-- [COMP:api/conversation-visibility] Visitor and member readers use the same
-- conversation restrictions for Page comments. The public route owns the live
-- link/site grant. Only that trusted host role can call the visitor receivers.
CREATE FUNCTION public.conversation_page_visitor_current(page_id uuid,sid uuid,guest_token text,mutation boolean)
RETURNS public.conversation_envelopes LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $visitor$
DECLARE e public.conversation_envelopes;s public.sessions;workspace uuid;
 sentinel constant uuid:='00000000-0000-0000-0000-0000000c0a57';
BEGIN
 IF mutation IS NULL OR (mutation AND guest_token IS NULL) THEN RETURN NULL;END IF;
 SELECT ct.workspace_id INTO workspace FROM public.comment_threads ct JOIN public.saved_views p
  ON p.id=ct.page_id AND p.workspace_id=ct.workspace_id WHERE ct.page_id=$1 AND ct.session_id=sid;
 IF workspace IS NULL THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.conversation_envelopes WHERE session_id=sid) THEN
  PERFORM public.classify_conversation_envelope(sid,true);
 END IF;
 IF mutation THEN
  SELECT * INTO s FROM public.sessions WHERE id=sid FOR UPDATE;
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid FOR UPDATE;
 ELSE
  SELECT * INTO s FROM public.sessions WHERE id=sid FOR SHARE;
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid FOR SHARE;
 END IF;
 IF s.id IS NULL OR e.session_id IS NULL OR e.workspace_id IS DISTINCT FROM workspace
  OR e.starter_user_id IS DISTINCT FROM s.user_id OR s.anchor_kind IS DISTINCT FROM 'doc_thread'
  OR s.recording_privacy_held OR public.scope_review_state_held('session',sid)
  OR e.cap IS DISTINCT FROM 'public' OR e.compartments<>'{}'::text[]
  OR (guest_token IS NULL AND (e.visibility<>'workspace' OR e.classification='legacy_personal' AND NOT public.conversation_consent_current(sid)))
  OR (guest_token IS NOT NULL AND (s.user_id<>sentinel OR s.guest_session_token IS DISTINCT FROM guest_token))
 THEN RETURN NULL;END IF;
 RETURN e;
END $visitor$;
REVOKE ALL ON FUNCTION public.conversation_page_visitor_current(uuid,uuid,text,boolean) FROM PUBLIC,app_user;

-- Only old sentinel-authored text on an exact guest Page binding. New writes
-- carry canonical public stamps. A historical authored guest comment doesn't
-- create a mandate to expose any unscoped member, model or tool row.
CREATE FUNCTION public.conversation_legacy_page_guest_rows(e public.conversation_envelopes,after_sequence integer,through_sequence integer)
RETURNS SETOF public.session_messages LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $guest_rows$
 SELECT m.* FROM public.session_messages m JOIN public.sessions s ON s.id=m.session_id
 JOIN public.comment_threads ct ON ct.session_id=s.id AND ct.workspace_id=e.workspace_id
 WHERE m.session_id=e.session_id AND s.anchor_kind='doc_thread' AND s.guest_session_token IS NOT NULL
  AND s.user_id='00000000-0000-0000-0000-0000000c0a57'::uuid AND m.sender_user_id=s.user_id AND m.role='user'
  AND m.sequence_num>after_sequence AND (through_sequence IS NULL OR m.sequence_num<=through_sequence)
  AND m.workspace_id IS NULL AND m.user_id IS NULL AND m.assistant_id IS NULL AND m.scope_held IS NOT TRUE
  AND m.sensitivity IS NULL AND m.compartments IS NULL AND m.project_ids IS NULL AND m.scope_version IS NULL
  AND jsonb_typeof(m.content)='string' AND m.attachments='[]'::jsonb
  AND NOT EXISTS(SELECT 1 FROM public.scope_resource_states r WHERE r.resource_kind='session_message' AND r.resource_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM public.scope_derivations d WHERE d.resource_kind='session_message' AND d.resource_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM public.conversation_message_quarantine q WHERE q.message_id=m.id AND q.reason<>'missing_stamp')
$guest_rows$;
REVOKE ALL ON FUNCTION public.conversation_legacy_page_guest_rows(public.conversation_envelopes,integer,integer) FROM PUBLIC,app_user;

CREATE FUNCTION public.read_native_page_conversation_rows(page_id uuid,guest_token text)
RETURNS TABLE("threadId" uuid,"sessionId" uuid,"anchorBlockId" text,quote text,"threadCreatedAt" timestamptz,
 "guestName" text,author text,avatar text,body text,"messageCreatedAt" timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $page_rows$
 SELECT ct.id,ct.session_id,ct.anchor_block_id,ct.quote,ct.created_at,ct.external_author_name,
  CASE WHEN m.sender_user_id='00000000-0000-0000-0000-0000000c0a57'::uuid THEN ct.external_author_name ELSE u.name END,
  CASE WHEN m.sender_user_id='00000000-0000-0000-0000-0000000c0a57'::uuid THEN NULL ELSE u.avatar_url END,
  nullif(public.conversation_searchable_text(m.content),''),m.created_at
 FROM public.comment_threads ct
 CROSS JOIN LATERAL public.conversation_page_visitor_current($1,ct.session_id,$2,false) e
 LEFT JOIN LATERAL (
  SELECT visible.* FROM public.conversation_record_rows(e,0,NULL,false,NULL,true) visible
  UNION ALL SELECT legacy.* FROM public.conversation_legacy_page_guest_rows(e,0,NULL) legacy
 ) m ON $2 IS NULL OR m.role='user' AND m.sender_user_id=e.starter_user_id
 LEFT JOIN public.users u ON u.id=m.sender_user_id
 WHERE ct.page_id=$1 AND e.session_id=ct.session_id
  AND ($2 IS NOT NULL OR ct.resolved_at IS NULL)
 ORDER BY ct.created_at,ct.id,m.sequence_num
$page_rows$;
REVOKE ALL ON FUNCTION public.read_native_page_conversation_rows(uuid,text) FROM PUBLIC,app_user;
