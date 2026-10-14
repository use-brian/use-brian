-- Routine Task source floors across metadata consumers and supersession.
-- Prefix 759 is the next free prefix AFTER the lexical migration tail 758.
-- It must run after 730's final native read_scope_source wrapper; 3947 would
-- sort before it. No old/applied migration is changed.
BEGIN;
CREATE OR REPLACE FUNCTION public.routine_task_sources_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt record;
BEGIN
 FOR receipt IN WITH RECURSIVE heads(id) AS (
  SELECT target UNION SELECT t.superseded_by FROM public.tasks t JOIN heads h ON t.id=h.id WHERE t.superseded_by IS NOT NULL
 ) SELECT r.workspace_id,r.source_evidence FROM heads h JOIN public.task_routine_intake_receipts r ON r.task_id=h.id LOOP
  IF public.workflow_scope_evidence_visible(receipt.workspace_id,receipt.source_evidence) IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER FUNCTION public.read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_routines;
REVOKE ALL ON FUNCTION public.read_scope_source_before_routines(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION public.read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 result:=public.read_scope_source_before_routines(w,k,i);
 IF k='task' AND result IS NOT NULL AND public.routine_task_sources_visible(i) IS NOT TRUE THEN
  -- Withheld current ancestry is not D1 deletion. Every native metadata,
  -- model-input and copied-outcome consumer sees an actual blocking state.
  result:=jsonb_set(result,'{held}','true'::jsonb);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_scope_source(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION public.protect_routine_signal_input() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.routine_intake_context IS NOT NULL AND NEW.input IS DISTINCT FROM OLD.input THEN
  RAISE EXCEPTION 'routine_signal_input_immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER routine_signal_input_immutable BEFORE UPDATE OF input ON public.workflow_runs
 FOR EACH ROW EXECUTE FUNCTION public.protect_routine_signal_input();
REVOKE ALL ON FUNCTION public.protect_routine_signal_input() FROM PUBLIC;
COMMIT;
