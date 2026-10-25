BEGIN;
-- [COMP:api/assistant-teardown] An owner-lane administrative anchor move is
-- valid only as part of the actual atomic deletion, never an ordinary patch.
CREATE FUNCTION application_task_assistant_delete_reanchor(before_row jsonb,after_row jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 w uuid:=(before_row->>'workspace_id')::uuid;old_assistant uuid:=(before_row->>'assistant_id')::uuid;
 primary_assistant uuid:=(after_row->>'assistant_id')::uuid;
BEGIN
 IF actor IS NULL OR old_assistant IS NULL OR primary_assistant IS NULL OR old_assistant=primary_assistant
  OR before_row-ARRAY['assistant_id','scope_version','updated_at'] IS DISTINCT FROM after_row-ARRAY['assistant_id','scope_version','updated_at']
  OR NOT EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass
    WHERE r.rolname=session_user AND pg_has_role(r.oid,c.relowner,'USAGE')) THEN RETURN false;END IF;
 PERFORM 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM 1 FROM public.assistants a WHERE a.id=old_assistant AND a.workspace_id=w AND a.kind='standard'
  AND a.owner_user_id=actor AND NOT EXISTS(SELECT 1 FROM public.assistant_members m WHERE m.assistant_id=a.id AND m.user_id<>actor) FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM 1 FROM public.assistants a WHERE a.id=primary_assistant AND a.workspace_id=w AND a.kind='primary' FOR SHARE;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION application_task_assistant_delete_reanchor(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_recheck_task_assistant_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=OLD.workspace_id) THEN RETURN NULL;END IF;
 IF OLD.assistant_id IS NOT NULL AND NEW.assistant_id IS NOT NULL AND OLD.assistant_id IS DISTINCT FROM NEW.assistant_id
  AND to_jsonb(OLD)-ARRAY['assistant_id','scope_version','updated_at'] IS NOT DISTINCT FROM to_jsonb(NEW)-ARRAY['assistant_id','scope_version','updated_at']
  AND EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass
    WHERE r.rolname=session_user AND pg_has_role(r.oid,c.relowner,'USAGE')) THEN
  IF EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=OLD.assistant_id)
   OR NOT EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=NEW.assistant_id AND a.workspace_id=OLD.workspace_id AND a.kind='primary') THEN
   RAISE EXCEPTION 'access_unavailable: task anchor move requires completed assistant deletion' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_recheck_task_assistant_delete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER application_task_assistant_delete_commit AFTER UPDATE ON public.tasks
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION application_recheck_task_assistant_delete();

DO $migration$
DECLARE definition text;target oid;metadata jsonb;
 before text:=$source$ IF key IN('assigneeId','executorAssistantId','followUpMemberId') AND application_native_task_fk_maintenance(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;$source$;
 replacement text:=$source$ IF key='' AND application_task_assistant_delete_reanchor(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
 IF key IN('assigneeId','executorAssistantId','followUpMemberId') AND application_native_task_fk_maintenance(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;$source$;
BEGIN
 target:='public.application_force_native_task_written_field()'::regprocedure;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Canonical Task written-field guard changed';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'Canonical Task written-field metadata changed';END IF;
END $migration$;
COMMIT;
