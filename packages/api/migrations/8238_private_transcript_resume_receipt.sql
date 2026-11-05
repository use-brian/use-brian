-- [COMP:api/private-transcript] One authenticated parent transition; message receipts stay immutable.
BEGIN;
CREATE OR REPLACE FUNCTION guard_private_legacy_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='session_legacy_history' AND TG_OP='UPDATE' THEN
  IF OLD.binding->3='null'::jsonb
   AND NEW.binding=jsonb_set(OLD.binding,'{3}',to_jsonb(OLD.workspace_id))
   AND to_jsonb(NEW)-'binding'=to_jsonb(OLD)-'binding'
   AND nullif(current_setting('app.current_user_id',true),'')::uuid=OLD.user_id
   AND current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='resume_private_legacy_session(uuid,uuid,uuid,integer)'::regprocedure))
   AND NOT EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_legacy_history'::regclass
    WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
   AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=OLD.session_id AND s.workspace_id=OLD.workspace_id
    AND private_legacy_history_binding(s)=NEW.binding)
  THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'legacy_history_immutable' USING ERRCODE='42501';
END $$;
COMMIT;
