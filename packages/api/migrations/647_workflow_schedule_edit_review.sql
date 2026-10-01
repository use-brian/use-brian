BEGIN;
-- A new editing principal does not rewrite historical creator/run identity.
ALTER TABLE workflows ADD COLUMN schedule_authoring_user_id uuid REFERENCES users(id);
CREATE TABLE workflow_schedule_edit_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  session_id uuid NOT NULL REFERENCES auth_sessions(id),
  policy_revision text NOT NULL,
  before_row jsonb NOT NULL,
  after_shape jsonb NOT NULL,
  patch jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
  payload_hash text NOT NULL,
  result_record jsonb,
  apply_txid text
);
ALTER TABLE workflow_schedule_edit_reviews ENABLE ROW LEVEL SECURITY;
-- No app policy: even a later blanket table grant cannot mint or consume consent.
REVOKE ALL ON workflow_schedule_edit_reviews FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON workflow_schedule_edit_reviews FROM app_user;
END IF; END $$;
CREATE FUNCTION workflow_schedule_review_shape(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(key,val),'{}'::jsonb) FROM jsonb_each(value) AS e(key,val)
  WHERE key=ANY(ARRAY['name','description','definition','enabled','trigger','model_alias','max_turns','research_mode',
    'context_group_id','context_project_id','authoring_authority','schedule_authoring_user_id',
    'name_manually_set','pinned','lifecycle_state'])
$$;
CREATE OR REPLACE FUNCTION protect_pinned_workflow_schedule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
    -- Noncanonical row-first writers must fail rather than invert lock order.
    PERFORM 1 FROM workspaces WHERE id=OLD.workspace_id FOR UPDATE NOWAIT;
    IF EXISTS (SELECT 1 FROM workflow_schedule_edit_reviews r
      JOIN auth_sessions s ON s.id=r.session_id AND s.user_id=r.actor_id
      JOIN users u ON u.id=r.actor_id
      JOIN workspace_members m ON m.workspace_id=OLD.workspace_id AND m.user_id=r.actor_id
      JOIN workspace_access_policies p ON p.workspace_id=OLD.workspace_id
      WHERE r.id=nullif(current_setting('app.workflow_schedule_review',true),'')::uuid
        AND r.actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid
        AND r.workflow_id=OLD.id AND r.apply_txid=txid_current()::text
        AND r.policy_revision=p.revision::text AND p.setup_state='ready'
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version
        AND r.expires_at>clock_timestamp() AND r.before_row=to_jsonb(OLD)
        AND r.after_shape=workflow_schedule_review_shape(to_jsonb(NEW)))
      AND NEW.created_by=OLD.created_by AND NEW.workspace_id=OLD.workspace_id
    THEN RETURN NEW; END IF;
    IF EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=OLD.workspace_id AND setup_state<>'legacy')
      AND (OLD.trigger->>'kind'='schedule' OR NEW.trigger->>'kind'='schedule')
      AND (workflow_schedule_review_shape(to_jsonb(NEW))-ARRAY['name','description','name_manually_set','pinned','lifecycle_state','enabled'])
        IS DISTINCT FROM (workflow_schedule_review_shape(to_jsonb(OLD))-ARRAY['name','description','name_manually_set','pinned','lifecycle_state','enabled'])
    THEN RAISE EXCEPTION 'workflow_schedule_reapproval_required'; END IF;
    IF EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=OLD.workspace_id AND setup_state<>'legacy')
      AND NEW.trigger->>'kind'='schedule' AND NEW.enabled AND NOT OLD.enabled
    THEN RAISE EXCEPTION 'workflow_schedule_reapproval_required'; END IF;
    IF NEW.schedule_authoring_user_id IS DISTINCT FROM OLD.schedule_authoring_user_id THEN
      RAISE EXCEPTION 'workflow_schedule_reapproval_required';
    END IF;
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
REVOKE ALL ON FUNCTION protect_pinned_workflow_schedule() FROM PUBLIC;
CREATE FUNCTION pause_workflow_schedule_jobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT NEW.enabled AND OLD.enabled THEN
  UPDATE scheduled_jobs SET enabled=false,schedule_claim_id=NULL,schedule_claim_expires_at=NULL
   WHERE workflow_id=NEW.id AND workflow_step_run_id IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pause_workflow_schedule_jobs() FROM PUBLIC;
CREATE TRIGGER pause_workflow_schedule_jobs AFTER UPDATE ON workflows
 FOR EACH ROW EXECUTE FUNCTION pause_workflow_schedule_jobs();
COMMIT;
