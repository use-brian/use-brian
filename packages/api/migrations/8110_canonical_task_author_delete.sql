BEGIN;
-- [COMP:api/assistant-teardown] A recorded assistant author is cleared only by
-- the actual referential delete, after canonical teardown re-anchors live rows.
ALTER TABLE public.tasks DROP CONSTRAINT tasks_created_by_assistant_id_fkey;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_created_by_assistant_id_fkey
 FOREIGN KEY (created_by_assistant_id) REFERENCES public.assistants(id) ON DELETE SET NULL;

DO $migration$
DECLARE definition text;target oid;metadata jsonb;
 before text := 'OR NEW.created_by_assistant_id IS DISTINCT FROM OLD.created_by_assistant_id';
 after text := $source$OR (NEW.created_by_assistant_id IS DISTINCT FROM OLD.created_by_assistant_id
    AND NOT (OLD.created_by_assistant_id IS NOT NULL AND NEW.created_by_assistant_id IS NULL
      AND pg_trigger_depth()>1
      AND NOT EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=OLD.created_by_assistant_id)))$source$;
BEGIN
 target:='public.application_guard_canonical_task_fields()'::regprocedure;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 IF (length(definition)-length(replace(definition,before,'')))/length(before) <> 1 THEN
  RAISE EXCEPTION 'Canonical native author invariant changed';
 END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Canonical native author guard metadata changed';
 END IF;
END $migration$;
COMMIT;
