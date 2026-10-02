-- Newly admitted workflow schedules pin existing workflow consent. No legacy
-- row is migrated, approved, enabled, or assigned a new default here.
BEGIN;
ALTER TABLE workflows ADD COLUMN schedule_authoring_pinned boolean NOT NULL DEFAULT false;
ALTER TABLE scheduled_jobs ADD COLUMN workflow_authoring_snapshot jsonb;
ALTER TABLE scheduled_jobs ADD COLUMN schedule_claim_id uuid;
-- Lease authority is independent of the mutable reminder deadline.
ALTER TABLE scheduled_jobs ADD COLUMN schedule_claim_expires_at timestamptz;
ALTER TABLE scheduled_jobs ADD COLUMN schedule_claim_consumed boolean NOT NULL DEFAULT false;
ALTER TABLE workflow_runs ADD COLUMN scheduled_job_id uuid;
ALTER TABLE workflow_runs ADD COLUMN scheduled_job_claim_id uuid UNIQUE;
ALTER TABLE workflow_runs ADD COLUMN scheduled_job_snapshot jsonb;
-- No FK to the transient firing row: deleting it must not erase run consent.
CREATE FUNCTION protect_scheduled_run_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.scheduled_job_id IS DISTINCT FROM OLD.scheduled_job_id
    OR NEW.scheduled_job_claim_id IS DISTINCT FROM OLD.scheduled_job_claim_id
    OR NEW.scheduled_job_snapshot IS DISTINCT FROM OLD.scheduled_job_snapshot THEN
    RAISE EXCEPTION 'workflow_schedule_binding_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_run_binding_immutable BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION protect_scheduled_run_binding();
CREATE UNIQUE INDEX scheduled_jobs_one_pinned_workflow_trigger
  ON scheduled_jobs(workflow_id) WHERE workflow_authoring_snapshot IS NOT NULL;

CREATE FUNCTION protect_pinned_workflow_schedule() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='scheduled_jobs' THEN
    IF NEW.workflow_authoring_snapshot IS DISTINCT FROM OLD.workflow_authoring_snapshot THEN
      RAISE EXCEPTION 'workflow_schedule_reapproval_required';
    END IF;
    IF OLD.workflow_authoring_snapshot IS NOT NULL AND (
      NEW.workflow_authoring_snapshot IS DISTINCT FROM OLD.workflow_authoring_snapshot
      OR (to_jsonb(NEW)-ARRAY['next_run_at','last_run_at','last_status','last_error','state_json','updated_at','enabled','failure_count','consecutive_failures','schedule_claim_id','schedule_claim_consumed','schedule_claim_expires_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['next_run_at','last_run_at','last_status','last_error','state_json','updated_at','enabled','failure_count','consecutive_failures','schedule_claim_id','schedule_claim_consumed','schedule_claim_expires_at'])
      OR (NEW.enabled AND NOT OLD.enabled)
    ) THEN RAISE EXCEPTION 'workflow_schedule_reapproval_required'; END IF;
  ELSE
    IF OLD.schedule_authoring_pinned AND NOT NEW.schedule_authoring_pinned THEN
      RAISE EXCEPTION 'workflow_schedule_reapproval_required';
    END IF;
    IF (OLD.schedule_authoring_pinned OR EXISTS(SELECT 1 FROM scheduled_jobs WHERE workflow_id=OLD.id AND workflow_authoring_snapshot IS NOT NULL)
      OR EXISTS(SELECT 1 FROM workflow_runs WHERE workflow_id=OLD.id AND scheduled_job_snapshot IS NOT NULL))
      AND (NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.authoring_authority IS DISTINCT FROM OLD.authoring_authority
        OR NEW.context_group_id IS DISTINCT FROM OLD.context_group_id
        OR NEW.context_project_id IS DISTINCT FROM OLD.context_project_id
        OR NEW.definition IS DISTINCT FROM OLD.definition
        OR NEW.model_alias IS DISTINCT FROM OLD.model_alias
        OR NEW.max_turns IS DISTINCT FROM OLD.max_turns
        OR NEW.research_mode IS DISTINCT FROM OLD.research_mode
        OR NEW.managed_by IS DISTINCT FROM OLD.managed_by
        OR NEW.trigger IS DISTINCT FROM OLD.trigger
        OR (NEW.enabled AND NOT OLD.enabled))
    THEN RAISE EXCEPTION 'workflow_schedule_reapproval_required'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pinned_workflow_schedule_immutable BEFORE UPDATE ON scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION protect_pinned_workflow_schedule();
CREATE TRIGGER pinned_workflow_definition_immutable BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION protect_pinned_workflow_schedule();
COMMIT;
