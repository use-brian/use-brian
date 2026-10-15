BEGIN;
-- [COMP:api/routine-proposals] A proposal reserves an id, not a subscription.
DROP POLICY routine_intake_proposal_insert ON public.pending_approvals;
DROP POLICY routine_intake_proposal_update ON public.pending_approvals;
DROP POLICY routine_intake_proposal_delete ON public.pending_approvals;
CREATE POLICY routine_intake_proposal_insert ON public.pending_approvals AS RESTRICTIVE FOR INSERT
 WITH CHECK(coalesce(arguments->>'operation','')<>'routine_intake'
  AND coalesce(tool_name,'') NOT IN('applyRoutineIntake','rejectRoutineIntake','setRoutineIntakeEnabled'));
CREATE POLICY routine_intake_proposal_update ON public.pending_approvals AS RESTRICTIVE FOR UPDATE
 USING(coalesce(arguments->>'operation','')<>'routine_intake'
  AND coalesce(tool_name,'') NOT IN('applyRoutineIntake','rejectRoutineIntake','setRoutineIntakeEnabled'))
 WITH CHECK(coalesce(arguments->>'operation','')<>'routine_intake'
  AND coalesce(tool_name,'') NOT IN('applyRoutineIntake','rejectRoutineIntake','setRoutineIntakeEnabled'));
CREATE POLICY routine_intake_proposal_delete ON public.pending_approvals AS RESTRICTIVE FOR DELETE
 USING(coalesce(arguments->>'operation','')<>'routine_intake'
  AND coalesce(tool_name,'') NOT IN('applyRoutineIntake','rejectRoutineIntake','setRoutineIntakeEnabled'));
CREATE FUNCTION public.stamp_new_routine_configuration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p record; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF NOT (NEW.definition ? 'taskIntake') THEN RETURN NEW; END IF;
 SELECT * INTO p FROM public.pending_approvals WHERE id=nullif(current_setting('app.routine_intake_apply_receipt',true),'')::uuid
   AND workspace_id=NEW.workspace_id AND kind='workflow_refinement' AND status='approved'
   AND approver_user_id=actor AND resolution_origin='human'
   AND arguments->>'operation'='routine_intake' AND arguments->>'mode'='create';
 IF p.id IS NULL OR p.arguments->>'workflowId' IS DISTINCT FROM NEW.id::text
   OR p.arguments->'before' IS DISTINCT FROM 'null'::jsonb OR p.arguments->>'expectedRevision'<>'0'
   OR p.arguments->'after' IS DISTINCT FROM public.routine_intake_material_shape(to_jsonb(NEW))
   OR p.arguments->'creation'->>'name' IS DISTINCT FROM NEW.name
   OR p.arguments->'creation'->>'authoringAssistantId' IS DISTINCT FROM NEW.authoring_authority->>'assistantId'
 THEN RAISE EXCEPTION 'routine_human_apply_required' USING ERRCODE='42501'; END IF;
 NEW.task_intake_revision:=1;
 NEW.task_intake_digest:=p.arguments->>'digest';
 NEW.task_intake_applied_by:=actor;
 NEW.task_intake_applied_at:=clock_timestamp();
 NEW.task_intake_apply_receipt:=p.id;
 NEW.task_intake_source_evidence:=p.arguments->'sourceEvidence';
 RETURN NEW;
END $$;
CREATE TRIGGER a_routine_creation_stamp BEFORE INSERT ON public.workflows
 FOR EACH ROW EXECUTE FUNCTION public.stamp_new_routine_configuration();
REVOKE ALL ON FUNCTION public.stamp_new_routine_configuration() FROM PUBLIC;

CREATE FUNCTION public.guard_routine_reenable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p record; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF NOT (OLD.definition ? 'taskIntake') OR OLD.enabled OR NOT NEW.enabled THEN RETURN NEW; END IF;
 SELECT * INTO p FROM public.pending_approvals WHERE id=nullif(current_setting('app.routine_intake_toggle_receipt',true),'')::uuid
  AND workspace_id=OLD.workspace_id AND kind='workflow_refinement' AND status='approved'
  AND approver_user_id=actor AND responded_by=actor AND resolution_origin='human'
  AND arguments->>'operation'='routine_intake' AND arguments->>'mode'='toggle';
 IF p.id IS NULL OR p.arguments->>'workflowId' IS DISTINCT FROM OLD.id::text
  OR p.arguments->>'expectedRevision' IS DISTINCT FROM OLD.task_intake_revision::text
  OR p.arguments->'enabled' IS DISTINCT FROM 'true'::jsonb OR p.arguments->'beforeEnabled' IS DISTINCT FROM 'false'::jsonb
  OR p.arguments->'before' IS DISTINCT FROM public.routine_intake_material_shape(to_jsonb(OLD))
  OR p.arguments->'after' IS DISTINCT FROM public.routine_intake_material_shape(to_jsonb(NEW))
 THEN RAISE EXCEPTION 'routine_human_apply_required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER routine_reenable_guard BEFORE UPDATE ON public.workflows
 FOR EACH ROW EXECUTE FUNCTION public.guard_routine_reenable();
REVOKE ALL ON FUNCTION public.guard_routine_reenable() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.routine_proposal_sources_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p record;
BEGIN
 SELECT workspace_id,arguments INTO p FROM public.pending_approvals WHERE id=target;
 IF p.arguments->>'operation' IS DISTINCT FROM 'routine_intake' THEN RETURN true; END IF;
 RETURN public.workflow_scope_evidence_visible(p.workspace_id,p.arguments->'sourceEvidence')
  AND (p.arguments->>'mode'='create' OR public.routine_configuration_shape_visible(p.workspace_id,p.arguments->'before'))
  AND public.routine_configuration_shape_visible(p.workspace_id,p.arguments->'after');
END $$;
-- Session erasure must not turn a private origin into a sessionless card.
UPDATE public.pending_approvals SET source_session_required=true
 WHERE arguments->>'operation'='routine_intake' AND blocking_session_id IS NOT NULL;
CREATE POLICY routine_proposal_origin_read ON public.pending_approvals AS RESTRICTIVE FOR SELECT
 USING(arguments->>'operation' IS DISTINCT FROM 'routine_intake'
  OR (blocking_session_id IS NULL AND NOT source_session_required)
  OR EXISTS(SELECT 1 FROM public.sessions s WHERE s.id=blocking_session_id AND s.workspace_id=pending_approvals.workspace_id));
CREATE POLICY routine_proposal_workflow_read ON public.pending_approvals AS RESTRICTIVE FOR SELECT
 USING(arguments->>'operation' IS DISTINCT FROM 'routine_intake'
  OR (arguments->>'mode'='create' AND status<>'approved')
  OR EXISTS(SELECT 1 FROM public.workflows w WHERE w.id::text=arguments->>'workflowId' AND w.workspace_id=pending_approvals.workspace_id));
COMMIT;
