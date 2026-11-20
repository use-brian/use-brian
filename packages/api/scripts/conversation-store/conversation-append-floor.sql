-- [COMP:api/conversation-visibility] A new row reaches the record only if
-- its original delivery falls within the envelope. Later bookkeeping or
-- upstream relabeling does not change that admission.
CREATE FUNCTION public.quarantine_unadmitted_conversation_append(message public.session_messages)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $append_floor$
DECLARE e public.conversation_envelopes;reason text;
BEGIN
 IF message.role NOT IN('user','assistant') THEN RETURN;END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=message.session_id FOR UPDATE;
 IF NOT FOUND OR e.workspace_id IS NULL THEN RETURN;END IF;
 reason:=CASE
  WHEN message.workspace_id IS DISTINCT FROM e.workspace_id OR message.sensitivity IS NULL
    OR message.compartments IS NULL OR message.project_ids IS NULL OR message.scope_version IS NULL THEN 'missing_stamp'
  WHEN message.user_id IS NOT NULL AND (e.visibility='workspace' OR message.user_id<>e.starter_user_id) THEN 'private_owner'
  WHEN public.sensitivity_rank(message.sensitivity)>public.sensitivity_rank(e.cap) THEN 'above_cap'
  WHEN NOT message.compartments<@e.compartments OR NOT message.project_ids<@public.conversation_hard_project_ids(e.compartments) THEN 'outside_boundary'
  ELSE NULL END;
 IF reason IS NOT NULL THEN
  INSERT INTO public.conversation_message_quarantine(session_id,message_id,reason)
  VALUES(message.session_id,message.id,reason) ON CONFLICT DO NOTHING;
 END IF;
END $append_floor$;
REVOKE ALL ON FUNCTION public.quarantine_unadmitted_conversation_append(public.session_messages) FROM PUBLIC,app_user;
