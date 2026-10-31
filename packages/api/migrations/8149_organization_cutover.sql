-- Owner-reviewed v2 cutover. No data erasure, grant widening or manufactured
-- dispatcher claims. The short apply transaction owns the inventory barrier.
BEGIN;
ALTER TABLE public.scheduled_jobs ADD COLUMN dispatch_lease_id uuid, ADD COLUMN dispatch_lease_expires_at timestamptz;
CREATE TABLE public.workspace_organization_cutover_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 auth_session_id uuid NOT NULL, -- Retain attribution after normal auth-session cleanup.
 target_department_id uuid NOT NULL,
 policy_revision bigint NOT NULL,
 idempotency_key uuid NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','applying','applied','cancelled')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '10 minutes'),
 applied_at timestamptz,
 UNIQUE(workspace_id,actor_user_id,idempotency_key),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,target_department_id) REFERENCES public.workspace_groups(workspace_id,id),
 CHECK((status='applied')=(applied_at IS NOT NULL AND result IS NOT NULL))
);
ALTER TABLE public.workspace_organization_cutover_reviews ENABLE ROW LEVEL SECURITY;
-- The canonical authenticated service writes with its backend connection;
-- transport/model JSON and ordinary app-role SQL cannot create an approval.
REVOKE ALL ON public.workspace_organization_cutover_reviews FROM PUBLIC;
ALTER TABLE public.workspace_access_policies ADD COLUMN completed_cutover_id uuid,
 ADD CONSTRAINT workspace_completed_cutover_local FOREIGN KEY(workspace_id,completed_cutover_id)
 REFERENCES public.workspace_organization_cutover_reviews(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.guard_organization_cutover_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.workspaces WHERE id=OLD.workspace_id) THEN RAISE EXCEPTION 'cutover_review_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'prepared' OR NEW.result IS NOT NULL OR NEW.applied_at IS NOT NULL THEN RAISE EXCEPTION 'cutover_review_immutable'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['status','result','applied_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','result','applied_at'])
    OR NOT (OLD.status='prepared' AND NEW.status IN ('applying','cancelled') OR OLD.status='applying' AND NEW.status='applied') THEN
   RAISE EXCEPTION 'cutover_review_immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_cutover_review_immutable BEFORE INSERT OR UPDATE OR DELETE
 ON public.workspace_organization_cutover_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_organization_cutover_review();
REVOKE ALL ON FUNCTION public.guard_organization_cutover_review() FROM PUBLIC;

CREATE FUNCTION public.check_organization_cutover_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.workspace_organization_cutover_reviews WHERE id=NEW.id AND status='applying') THEN
   RAISE EXCEPTION 'cutover_apply_incomplete';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER organization_cutover_atomic_commit
 AFTER INSERT OR UPDATE ON public.workspace_organization_cutover_reviews
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_organization_cutover_commit();
REVOKE ALL ON FUNCTION public.check_organization_cutover_commit() FROM PUBLIC;

-- Extend the existing immutable-schedule guard for exactly the conversion
-- reviewed by the owner. Every other immutable-schedule/reapproval rule stays.
DO $migration$
DECLARE definition text; at_begin integer; preamble text;
BEGIN
 definition:=pg_get_functiondef('public.protect_pinned_workflow_schedule()'::regprocedure);
 at_begin:=position(E'BEGIN\n' IN definition);
 IF at_begin=0 THEN RAISE EXCEPTION 'cutover_schedule_guard_schema_changed'; END IF;
 preamble:=$guard$
  IF TG_TABLE_NAME='scheduled_jobs' THEN
  IF OLD.workflow_authoring_snapshot IS NULL
    AND NEW.workflow_authoring_snapshot IS NOT NULL
    AND (to_jsonb(NEW)-ARRAY['workflow_authoring_snapshot','updated_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['workflow_authoring_snapshot','updated_at'])
    AND EXISTS (
      SELECT 1 FROM public.workspace_organization_cutover_reviews r
      JOIN public.workspaces workspace ON workspace.id=r.workspace_id AND workspace.owner_user_id=r.actor_user_id
      JOIN public.auth_sessions session ON session.id=r.auth_session_id AND session.user_id=r.actor_user_id
      JOIN public.users actor ON actor.id=r.actor_user_id AND actor.auth_version=session.auth_version
      JOIN public.workflows workflow ON workflow.id=NEW.workflow_id AND workflow.workspace_id=r.workspace_id
      CROSS JOIN LATERAL jsonb_array_elements(r.evidence->'schedules') item
      WHERE r.id::text=nullif(current_setting('app.organization_cutover_review',true),'')
        AND r.actor_user_id::text=nullif(current_setting('app.current_user_id',true),'')
        AND r.status='applying' AND r.expires_at>clock_timestamp()
        AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
        AND item->>'id'=OLD.id::text AND item->>'workflowId'=workflow.id::text
        AND item->>'oldFingerprint'=encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex')
        AND item->>'sourceFingerprint'=encode(sha256(convert_to(jsonb_build_object(
          'authority',workflow.authoring_authority,'definition',workflow.definition,'trigger',workflow.trigger,
          'groupId',workflow.context_group_id,'projectId',workflow.context_project_id,
          'userId',coalesce(workflow.schedule_authoring_user_id,workflow.created_by),'workspaceId',workflow.workspace_id)::text,'UTF8')),'hex')
        AND NEW.workflow_authoring_snapshot=jsonb_build_object(
          'authority',workflow.authoring_authority,'definition',workflow.definition,'trigger',workflow.trigger,
          'groupId',workflow.context_group_id,'projectId',workflow.context_project_id,
          'userId',coalesce(workflow.schedule_authoring_user_id,workflow.created_by),'workspaceId',workflow.workspace_id)
        AND NEW.user_id=coalesce(workflow.schedule_authoring_user_id,workflow.created_by)
        AND NEW.assistant_id::text=workflow.authoring_authority->>'assistantId'
        AND NEW.workflow_step_run_id IS NULL
    ) THEN RETURN NEW; END IF;
  END IF;
$guard$;
 EXECUTE substring(definition FROM 1 FOR at_begin+5)||preamble||substring(definition FROM at_begin+6);
END
$migration$;
COMMIT;
