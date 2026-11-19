-- [COMP:api/conversation-visibility] Current outward provenance adds a
-- restrictive leg to the resource's original native policy.
CREATE INDEX workspace_files_conversation_record_predecessor
 ON public.workspace_files(workspace_id,superseded_by) WHERE superseded_by IS NOT NULL;

CREATE FUNCTION public.conversation_record_resource_current(w uuid,k text,i uuid,v text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $resource_current$
 SELECT CASE WHEN k IN('memory','task','workspace_file') AND EXISTS(
  SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w
   AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) THEN
  public.conversation_record_derivation_current(w,k,i,v,nullif(current_setting('app.current_user_id',true),'')::uuid)
  ELSE false END
$resource_current$;
REVOKE ALL ON FUNCTION public.conversation_record_resource_current(uuid,text,uuid,text) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.conversation_record_resource_current(uuid,text,uuid,text) TO app_user;

CREATE POLICY memories_conversation_record_ancestry ON public.memories AS RESTRICTIVE FOR SELECT TO app_user
 USING(public.conversation_record_resource_current(workspace_id,'memory',id,scope_version::text));
CREATE POLICY tasks_conversation_record_ancestry ON public.tasks AS RESTRICTIVE FOR SELECT TO app_user
 USING(public.conversation_record_resource_current(workspace_id,'task',id,scope_version::text));
CREATE POLICY workspace_files_conversation_record_ancestry ON public.workspace_files AS RESTRICTIVE FOR SELECT TO app_user
 USING(public.conversation_record_resource_current(workspace_id,'workspace_file',id,scope_version::text));

CREATE FUNCTION public.require_conversation_record_retention_current() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $retention$
DECLARE kind text;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 kind:=CASE TG_TABLE_NAME WHEN 'memories' THEN 'memory' WHEN 'tasks' THEN 'task' WHEN 'workspace_files' THEN 'workspace_file' END;
 IF kind IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF actor IS NULL AND EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid=TG_RELID
  WHERE r.rolname=session_user AND NOT (r.rolsuper OR r.rolbypassrls) AND pg_has_role(r.oid,c.relowner,'USAGE'))
 THEN actor:=NEW.created_by_user_id;END IF;
 -- At transaction end the native writer has attached the complete retained
 -- evidence to this physical output. Verify against both its author and its
 -- actual recipient, with the original write admission still in force.
 IF public.conversation_record_derivation_current(NEW.workspace_id,kind,NEW.id,NEW.scope_version::text,NEW.user_id) IS NOT TRUE
  OR actor IS DISTINCT FROM NEW.user_id AND public.conversation_record_derivation_current(
   NEW.workspace_id,kind,NEW.id,NEW.scope_version::text,actor) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $retention$;
REVOKE ALL ON FUNCTION public.require_conversation_record_retention_current() FROM PUBLIC,app_user;
CREATE CONSTRAINT TRIGGER conversation_record_retention_current
 AFTER INSERT ON public.memories DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.require_conversation_record_retention_current();
CREATE CONSTRAINT TRIGGER conversation_record_retention_current
 AFTER INSERT ON public.tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.require_conversation_record_retention_current();
CREATE CONSTRAINT TRIGGER conversation_record_retention_current
 AFTER INSERT ON public.workspace_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.require_conversation_record_retention_current();
