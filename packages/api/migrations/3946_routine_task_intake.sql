-- Configured routine intake (features/routine-work-intake.md). Legacy off.
-- Numeric reservation: 3946 was free in both open/platform migration dirs.
-- The migrator orders lexically. Functions referencing later scope helpers
-- are PL/pgSQL (resolved at invocation); no backfill invokes them here.
BEGIN;

ALTER TABLE public.workflows
 ADD COLUMN task_intake_revision bigint NOT NULL DEFAULT 0 CHECK(task_intake_revision>=0),
 ADD COLUMN task_intake_generation bigint NOT NULL DEFAULT 0 CHECK(task_intake_generation>=0),
 ADD COLUMN task_intake_digest text,
 ADD COLUMN task_intake_applied_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
 ADD COLUMN task_intake_applied_at timestamptz,
 ADD COLUMN task_intake_source_evidence jsonb,
 ADD COLUMN task_intake_apply_receipt uuid REFERENCES public.pending_approvals(id) ON DELETE SET NULL;

ALTER TABLE public.workflow_runs ADD COLUMN routine_intake_context jsonb;
CREATE FUNCTION public.freeze_routine_run_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE workflow record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.routine_intake_context IS DISTINCT FROM OLD.routine_intake_context THEN
   RAISE EXCEPTION 'routine_run_context_immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 -- Never trust a value supplied by a run caller.
 NEW.routine_intake_context:=NULL;
 SELECT * INTO workflow FROM public.workflows WHERE id=NEW.workflow_id AND workspace_id=NEW.workspace_id FOR SHARE;
 IF NEW.trigger_kind='event' AND workflow.enabled AND workflow.task_intake_revision>0 AND workflow.definition ? 'taskIntake' THEN
  NEW.routine_intake_context:=jsonb_build_object('revision',workflow.task_intake_revision,'generation',workflow.task_intake_generation,'digest',workflow.task_intake_digest,
   'authorUserId',workflow.task_intake_applied_by,'authority',workflow.authoring_authority,
   'sourceEvidence',workflow.task_intake_source_evidence,
   'configuration',public.routine_intake_material_shape(to_jsonb(workflow)));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER routine_run_context BEFORE INSERT OR UPDATE ON public.workflow_runs
 FOR EACH ROW EXECUTE FUNCTION public.freeze_routine_run_context();

CREATE TABLE public.task_routine_intake_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 -- Accepted identity survives definition deletion; deleting a routine is not
 -- revoking a committed Task's mandate. No live workflow dependency here.
 routine_id uuid NOT NULL,
 accepted_revision bigint NOT NULL CHECK(accepted_revision>0),
 accepted_digest text NOT NULL,
 case_key text NOT NULL CHECK(length(case_key) BETWEEN 1 AND 1000),
 run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
 task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
 source_evidence jsonb NOT NULL,
 basis jsonb NOT NULL,
 executor jsonb NOT NULL,
 home jsonb NOT NULL,
 qualification jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,routine_id,case_key)
);
CREATE INDEX task_routine_intake_receipts_task ON public.task_routine_intake_receipts(task_id);
ALTER TABLE public.task_routine_intake_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_routine_intake_receipts FROM PUBLIC;

CREATE FUNCTION public.routine_intake_material_shape(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('definition',(value->'definition')-'layout','trigger',value->'trigger',
  'contextGroupId',value->'context_group_id','contextProjectId',value->'context_project_id')
$$;

-- Engine-owned proposal subtype and durable tool proof: app-role clients can
-- inspect admitted rows but cannot manufacture a human decision in the table.
CREATE POLICY routine_intake_proposal_insert ON public.pending_approvals AS RESTRICTIVE FOR INSERT
 WITH CHECK(coalesce(arguments->>'operation','')<>'routine_intake' AND coalesce(tool_name,'')<>'applyRoutineIntake');
CREATE POLICY routine_intake_proposal_update ON public.pending_approvals AS RESTRICTIVE FOR UPDATE
 USING(coalesce(arguments->>'operation','')<>'routine_intake' AND coalesce(tool_name,'')<>'applyRoutineIntake')
 WITH CHECK(coalesce(arguments->>'operation','')<>'routine_intake' AND coalesce(tool_name,'')<>'applyRoutineIntake');
CREATE POLICY routine_intake_proposal_delete ON public.pending_approvals AS RESTRICTIVE FOR DELETE
 USING(coalesce(arguments->>'operation','')<>'routine_intake' AND coalesce(tool_name,'')<>'applyRoutineIntake');
CREATE UNIQUE INDEX routine_intake_proposal_idempotency ON public.pending_approvals
 (workspace_id,(arguments->>'workflowId'),(arguments->>'idempotencyKey'))
 WHERE kind='workflow_refinement' AND arguments->>'operation'='routine_intake';

CREATE FUNCTION public.protect_routine_intake_configuration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt record; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 changed boolean; old_revision bigint:=0;
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.task_intake_generation:=0;
  changed:=NEW.definition ? 'taskIntake' OR NEW.task_intake_revision<>0 OR NEW.task_intake_digest IS NOT NULL;
 ELSE
  NEW.task_intake_generation:=OLD.task_intake_generation+CASE WHEN NEW.enabled IS DISTINCT FROM OLD.enabled THEN 1 ELSE 0 END;
  -- Native erasure can remove an author/approval FK without changing mandate
  -- content. Such loss never manufactures fresh authoring proof.
  IF public.routine_intake_material_shape(to_jsonb(OLD)) IS NOT DISTINCT FROM public.routine_intake_material_shape(to_jsonb(NEW))
   AND NEW.authoring_authority IS NOT DISTINCT FROM OLD.authoring_authority
   AND NEW.task_intake_revision=OLD.task_intake_revision AND NEW.task_intake_digest IS NOT DISTINCT FROM OLD.task_intake_digest
   AND NEW.task_intake_applied_at IS NOT DISTINCT FROM OLD.task_intake_applied_at
   AND NEW.task_intake_source_evidence IS NOT DISTINCT FROM OLD.task_intake_source_evidence
   AND (NEW.task_intake_applied_by IS NOT DISTINCT FROM OLD.task_intake_applied_by
     OR NEW.task_intake_applied_by IS NULL AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=OLD.task_intake_applied_by))
   AND (NEW.task_intake_apply_receipt IS NOT DISTINCT FROM OLD.task_intake_apply_receipt
     OR NEW.task_intake_apply_receipt IS NULL AND NOT EXISTS(SELECT 1 FROM public.pending_approvals WHERE id=OLD.task_intake_apply_receipt))
  THEN RETURN NEW; END IF;
  old_revision:=OLD.task_intake_revision;
  changed:=(OLD.definition ? 'taskIntake' OR NEW.definition ? 'taskIntake')
   AND (public.routine_intake_material_shape(to_jsonb(OLD)) IS DISTINCT FROM public.routine_intake_material_shape(to_jsonb(NEW))
    OR NEW.authoring_authority IS DISTINCT FROM OLD.authoring_authority);
  changed:=changed OR NEW.task_intake_revision IS DISTINCT FROM OLD.task_intake_revision
   OR NEW.task_intake_digest IS DISTINCT FROM OLD.task_intake_digest
   OR NEW.task_intake_applied_by IS DISTINCT FROM OLD.task_intake_applied_by
   OR NEW.task_intake_applied_at IS DISTINCT FROM OLD.task_intake_applied_at
   OR NEW.task_intake_source_evidence IS DISTINCT FROM OLD.task_intake_source_evidence
   OR NEW.task_intake_apply_receipt IS DISTINCT FROM OLD.task_intake_apply_receipt;
 END IF;
 IF NOT changed THEN RETURN NEW; END IF;
 SELECT p.* INTO receipt FROM public.pending_approvals p
  WHERE p.id=nullif(current_setting('app.routine_intake_apply_receipt',true),'')::uuid
   AND p.workspace_id=NEW.workspace_id AND p.kind='workflow_refinement'
   AND p.arguments->>'operation'='routine_intake' AND p.status='approved'
   AND p.approver_user_id=actor
   AND coalesce(to_jsonb(p)->>'resolution_origin','human')='human';
 IF receipt.id IS NULL OR receipt.arguments->>'workflowId' IS DISTINCT FROM NEW.id::text
  OR receipt.arguments->>'expectedRevision' IS DISTINCT FROM old_revision::text
  OR receipt.arguments->'after' IS DISTINCT FROM public.routine_intake_material_shape(to_jsonb(NEW))
  OR NEW.task_intake_revision<>old_revision+1 OR NEW.task_intake_applied_by IS DISTINCT FROM actor
  OR NEW.task_intake_apply_receipt IS DISTINCT FROM receipt.id OR NEW.task_intake_digest IS NULL
  OR NEW.task_intake_digest IS DISTINCT FROM receipt.arguments->>'digest'
  OR NEW.task_intake_source_evidence IS DISTINCT FROM receipt.arguments->'sourceEvidence'
  OR NEW.task_intake_applied_at IS NULL
 THEN RAISE EXCEPTION 'routine_human_apply_required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER routine_intake_configuration_guard BEFORE INSERT OR UPDATE ON public.workflows
 FOR EACH ROW EXECUTE FUNCTION public.protect_routine_intake_configuration();

CREATE FUNCTION public.routine_task_sources_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt record;
BEGIN
 FOR receipt IN SELECT workspace_id,source_evidence FROM public.task_routine_intake_receipts WHERE task_id=target LOOP
  IF public.workflow_scope_evidence_visible(receipt.workspace_id,receipt.source_evidence) IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE POLICY routine_task_sources ON public.tasks AS RESTRICTIVE FOR SELECT USING(public.routine_task_sources_visible(id));
CREATE POLICY routine_receipt_read ON public.task_routine_intake_receipts FOR SELECT
 USING(EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id AND t.workspace_id=task_routine_intake_receipts.workspace_id));

CREATE FUNCTION public.routine_configuration_shape_visible(w uuid,configuration jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; project uuid;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=w AND user_id=actor)
  OR public.workflow_definition_department_allows(w,(configuration->>'contextGroupId')::uuid) IS NOT TRUE THEN RETURN false; END IF;
 project:=(configuration->>'contextProjectId')::uuid;
 IF project IS NOT NULL AND public.task_home_admissible(actor,w,'project',project) IS NOT TRUE THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
CREATE FUNCTION public.routine_proposal_sources_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE proposal record;
BEGIN
 SELECT workspace_id,arguments INTO proposal FROM public.pending_approvals WHERE id=target;
 IF proposal.arguments->>'operation' IS DISTINCT FROM 'routine_intake' THEN RETURN true; END IF;
 RETURN public.workflow_scope_evidence_visible(proposal.workspace_id,proposal.arguments->'sourceEvidence')
  AND public.routine_configuration_shape_visible(proposal.workspace_id,proposal.arguments->'before')
  AND public.routine_configuration_shape_visible(proposal.workspace_id,proposal.arguments->'after');
END $$;
CREATE POLICY routine_proposal_sources ON public.pending_approvals AS RESTRICTIVE FOR SELECT
 USING(public.routine_proposal_sources_visible(id));
CREATE FUNCTION public.routine_workflow_sources_visible(w uuid,evidence jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF evidence IS NULL THEN RETURN true; END IF;
 RETURN public.workflow_scope_evidence_visible(w,evidence);
END $$;
CREATE POLICY routine_configuration_sources ON public.workflows AS RESTRICTIVE FOR ALL
 USING(public.routine_workflow_sources_visible(workspace_id,task_intake_source_evidence))
 WITH CHECK(public.routine_workflow_sources_visible(workspace_id,task_intake_source_evidence));

-- Supersession is a canonical head transition, not a fresh intake/allowance.
CREATE FUNCTION public.repoint_routine_task_receipts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL THEN
  UPDATE public.task_routine_intake_receipts SET task_id=NEW.superseded_by WHERE task_id=OLD.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER routine_receipt_task_head AFTER UPDATE OF superseded_by ON public.tasks
 FOR EACH ROW EXECUTE FUNCTION public.repoint_routine_task_receipts();

REVOKE ALL ON FUNCTION public.protect_routine_intake_configuration() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repoint_routine_task_receipts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_routine_run_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_task_sources_visible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_configuration_shape_visible(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_proposal_sources_visible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_workflow_sources_visible(uuid,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT SELECT ON public.task_routine_intake_receipts TO app_user;
 GRANT EXECUTE ON FUNCTION public.routine_task_sources_visible(uuid) TO app_user;
 GRANT EXECUTE ON FUNCTION public.routine_configuration_shape_visible(uuid,jsonb) TO app_user;
 GRANT EXECUTE ON FUNCTION public.routine_proposal_sources_visible(uuid) TO app_user;
 GRANT EXECUTE ON FUNCTION public.routine_workflow_sources_visible(uuid,jsonb) TO app_user;
END IF; END $$;
COMMIT;
