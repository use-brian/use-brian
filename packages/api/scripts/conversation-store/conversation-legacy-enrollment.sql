-- [COMP:api/conversation-visibility] Preserve the original 8203 receipt
-- through authorized private context changes. Do not rebase the receipt.
CREATE TABLE public.conversation_legacy_history_enrollments(
 session_id uuid PRIMARY KEY REFERENCES public.session_legacy_history(session_id) ON DELETE CASCADE,
 descriptor_digest text NOT NULL CHECK(descriptor_digest ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.conversation_legacy_history_enrollments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_legacy_history_enrollments FROM PUBLIC,app_user;

CREATE FUNCTION public.enroll_conversation_legacy_history(sid uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $enrollment$
DECLARE s public.sessions;h public.session_legacy_history;e public.conversation_envelopes;digest text;
BEGIN
 SELECT * INTO s FROM public.sessions WHERE id=sid FOR SHARE;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid;
 IF NOT FOUND OR e.visibility<>'private_by_kind' OR e.workspace_id IS NULL
  OR s.user_id IS DISTINCT FROM e.starter_user_id THEN RETURN false;END IF;
 SELECT * INTO h FROM public.session_legacy_history WHERE session_id=sid AND workspace_id=e.workspace_id
  AND user_id=e.starter_user_id;
 IF NOT FOUND THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM public.conversation_legacy_history_enrollments WHERE session_id=sid) THEN
  RETURN public.conversation_legacy_enrolled(sid,e.workspace_id,s.user_id,s.assistant_id);
 END IF;
 IF h.binding IS DISTINCT FROM public.private_legacy_history_binding(s)
  OR NOT EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=s.assistant_id AND a.workspace_id=e.workspace_id)
 THEN RETURN false;END IF;
 digest:=encode(sha256(convert_to(to_jsonb(h)::text,'UTF8')),'hex');
 INSERT INTO public.conversation_legacy_history_enrollments(session_id,descriptor_digest) VALUES(sid,digest)
 ON CONFLICT(session_id) DO NOTHING;
 RETURN public.conversation_legacy_enrolled(sid,e.workspace_id,s.user_id,s.assistant_id);
END $enrollment$;
REVOKE ALL ON FUNCTION public.enroll_conversation_legacy_history(uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_legacy_enrolled(sid uuid,w uuid,starter uuid,assistant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $legacy$
 SELECT EXISTS(SELECT 1 FROM public.conversation_legacy_history_enrollments authenticated
  JOIN public.session_legacy_history h USING(session_id)
  JOIN public.sessions s ON s.id=h.session_id AND s.user_id=h.user_id AND s.assistant_id=assistant
  JOIN public.assistants a ON a.id=s.assistant_id AND a.workspace_id=h.workspace_id
  JOIN public.conversation_envelopes e ON e.session_id=s.id AND e.workspace_id=h.workspace_id
   AND e.starter_user_id=h.user_id AND e.visibility='private_by_kind'
  LEFT JOIN LATERAL(SELECT audit.after_envelope FROM public.conversation_visibility_audit audit
   WHERE audit.session_id=sid ORDER BY audit.next_version DESC LIMIT 1) latest ON true
  WHERE h.session_id=sid AND h.workspace_id=w AND h.user_id=starter AND coalesce(s.workspace_id,a.workspace_id)=w
   AND h.binding->>0=sid::text AND h.binding->>1=starter::text AND h.binding->>2=assistant::text
   AND authenticated.descriptor_digest=encode(sha256(convert_to(to_jsonb(h)::text,'UTF8')),'hex')
   AND (h.binding=public.private_legacy_history_binding(s) OR latest.after_envelope->>'legacyBindingDigest'
    =encode(sha256(convert_to(public.private_legacy_history_binding(s)::text,'UTF8')),'hex')))
$legacy$;
REVOKE ALL ON FUNCTION public.conversation_legacy_enrolled(uuid,uuid,uuid,uuid) FROM PUBLIC,app_user;
