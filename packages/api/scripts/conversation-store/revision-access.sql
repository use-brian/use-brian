-- [COMP:api/native-turn-frame] Canonical row-level turn-frame admission.
DO $revision_access$
DECLARE definition text;previous text:=$old$ IF EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i AND r.parent_kind='turn_frame')
  AND native_turn_helpers_current() IS TRUE THEN
  chat_proof:=read_native_turn_requirements(w,jsonb_build_array(jsonb_build_object('kind','session_context_revision','id',i,'version','1')));
  IF chat_proof->>'available'='true' THEN RETURN (chat_proof->>'admitted'='true') IS TRUE;END IF;
 END IF;$old$;
BEGIN
 definition:=pg_get_functiondef('session_context_revision_allowed(uuid,uuid)'::regprocedure);
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'conversation_revision_access_predecessor_changed';END IF;
 EXECUTE replace(definition,previous,$new$ IF EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i AND r.parent_kind IN('turn_frame','session_title'))
  AND actor IS NOT NULL AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass
   WHERE login.rolname=session_user AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN
  chat_proof:=capture_conversation_evidence(w,jsonb_build_array(jsonb_build_object('kind','session_context_revision','id',i,'version','1')));
  IF chat_proof IS NOT NULL THEN RETURN (chat_proof->>'admitted'='true') IS TRUE;END IF;
 END IF;$new$);
END $revision_access$;
