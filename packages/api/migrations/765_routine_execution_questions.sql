BEGIN;
-- [COMP:api/routine-intake-execution] Native questions retain their Task floor.
CREATE UNIQUE INDEX routine_execution_receipt_once ON public.task_execution_states ((authoring_ref->>'receiptId'))
 WHERE lane='native' AND parent_state_id IS NULL AND authoring_ref->>'kind'='routine_assignment';
CREATE UNIQUE INDEX routine_input_question_revision ON public.pending_approvals
 ((approval_payload->>'executionId'), (approval_payload->>'controlRevision'))
 WHERE kind='question' AND approval_payload->>'operation'='routine_input';

CREATE FUNCTION public.routine_question_route_admitted(target uuid,chat uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.tasks; s public.sessions; r record; ref jsonb; snapshot jsonb; shared boolean;
BEGIN
 SELECT * INTO t FROM public.tasks WHERE id=target AND valid_to IS NULL AND retracted_at IS NULL;
 IF NOT FOUND OR public.routine_task_sources_visible(target) IS NOT TRUE THEN RETURN false; END IF;
 SELECT * INTO s FROM public.sessions WHERE id=chat AND workspace_id=t.workspace_id;
 IF NOT FOUND THEN RETURN false; END IF;
 -- Canonical persisted audience from migration 741 (the same predicate as
 -- sessionKindSql.workspaceAudience); legacy draft discriminators are gone.
 shared:=s.visibility='workspace';
 -- Personal sessions have one admitted recipient. Shared sessions must carry
 -- every source floor; no arbitrary owner or broader chat is a fallback.
 IF NOT shared THEN RETURN s.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid; END IF;
 IF t.user_id IS NOT NULL OR t.assistant_id IS NOT NULL
   OR public.sensitivity_rank(s.effective_clearance)<public.sensitivity_rank(t.sensitivity)
   OR NOT(coalesce(s.context_compartments,'{}'::text[]) @> t.compartments)
   OR NOT(t.project_ids <@ CASE WHEN s.context_project_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[s.context_project_id] END)
 THEN RETURN false; END IF;
 FOR r IN SELECT workspace_id,source_evidence FROM public.task_routine_intake_receipts WHERE task_id=target LOOP
   FOR ref IN SELECT value FROM jsonb_array_elements(coalesce(r.source_evidence->'sources','[]')) LOOP
     snapshot:=public.read_scope_source(r.workspace_id,ref->>'resourceKind',(ref->>'resourceId')::uuid);
     IF snapshot IS NULL OR coalesce((snapshot->>'held')::boolean,false)
       OR snapshot->>'userId' IS NOT NULL OR snapshot->>'assistantId' IS NOT NULL
       OR public.sensitivity_rank(s.effective_clearance)<public.sensitivity_rank(snapshot->>'sensitivity')
       OR NOT(to_jsonb(coalesce(s.context_compartments,'{}'::text[])) @> coalesce(snapshot->'compartments','[]'))
       OR NOT(to_jsonb(CASE WHEN s.context_project_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[s.context_project_id] END)
         @> coalesce(snapshot->'projectIds','[]')) THEN RETURN false; END IF;
   END LOOP;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION public.routine_input_question_visible(payload jsonb,chat uuid,decision text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF payload->>'operation' IS DISTINCT FROM 'routine_input' THEN RETURN true; END IF;
 RETURN EXISTS(SELECT 1 FROM public.task_execution_states e JOIN public.tasks t ON t.id=e.task_id
   WHERE e.id=(payload->>'executionId')::uuid AND e.authoring_ref->>'kind'='routine_assignment'
     AND (decision<>'pending' OR (e.control_revision=(payload->>'controlRevision')::bigint AND e.phase='waiting' AND e.goal_id IS NULL))
     AND EXISTS(SELECT 1 FROM public.task_routine_intake_receipts r WHERE r.task_id=t.id AND r.id=(e.authoring_ref->>'receiptId')::uuid)
     AND public.routine_question_route_admitted(t.id,chat));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
CREATE POLICY routine_input_question_source ON public.pending_approvals AS RESTRICTIVE FOR SELECT
 USING(public.routine_input_question_visible(approval_payload,blocking_session_id,status));
CREATE POLICY routine_input_question_insert ON public.pending_approvals AS RESTRICTIVE FOR INSERT
 WITH CHECK(approval_payload->>'operation' IS DISTINCT FROM 'routine_input');
CREATE POLICY routine_input_question_update ON public.pending_approvals AS RESTRICTIVE FOR UPDATE
 USING(approval_payload->>'operation' IS DISTINCT FROM 'routine_input')
 WITH CHECK(approval_payload->>'operation' IS DISTINCT FROM 'routine_input');
CREATE POLICY routine_input_question_delete ON public.pending_approvals AS RESTRICTIVE FOR DELETE
 USING(approval_payload->>'operation' IS DISTINCT FROM 'routine_input');

REVOKE ALL ON FUNCTION public.routine_question_route_admitted(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_input_question_visible(jsonb,uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION public.routine_question_route_admitted(uuid,uuid) TO app_user;
 GRANT EXECUTE ON FUNCTION public.routine_input_question_visible(jsonb,uuid,text) TO app_user;
END IF; END $$;
COMMIT;
