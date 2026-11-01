-- Attended, one-time adoption of a legacy knowledge source. No output rewrite.
BEGIN;
CREATE TABLE public.workspace_knowledge_binding_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 source_id uuid NOT NULL, -- Keep the receipt after normal source removal.
 actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 auth_session_id uuid NOT NULL,
 target_department_id uuid NOT NULL,
 policy_revision bigint NOT NULL,
 idempotency_key uuid NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','applying','applied','cancelled')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 applied_at timestamptz,
 UNIQUE(workspace_id,actor_user_id,idempotency_key),
 FOREIGN KEY(workspace_id,target_department_id) REFERENCES public.workspace_groups(workspace_id,id),
 CHECK((status='applied')=(applied_at IS NOT NULL AND result IS NOT NULL))
);
ALTER TABLE public.workspace_knowledge_binding_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_knowledge_binding_reviews FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON public.workspace_knowledge_binding_reviews FROM app_user;
END IF; END $$;
CREATE TRIGGER knowledge_binding_review_immutable BEFORE INSERT OR UPDATE OR DELETE
 ON public.workspace_knowledge_binding_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_organization_cutover_review();
CREATE FUNCTION public.check_knowledge_binding_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.workspace_knowledge_binding_reviews WHERE id=NEW.id AND status='applying') THEN
  RAISE EXCEPTION 'knowledge_binding_apply_incomplete';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER knowledge_binding_atomic_commit AFTER INSERT OR UPDATE
 ON public.workspace_knowledge_binding_reviews DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.check_knowledge_binding_commit();
REVOKE ALL ON FUNCTION public.check_knowledge_binding_commit() FROM PUBLIC;

-- Preserve the original guard for every other operation. A caller-set GUC is
-- only a reference: it must match a backend-only, applying, live human review.
DO $migration$
DECLARE definition text; at_begin integer; preamble text;
BEGIN
 definition:=pg_get_functiondef('public.guard_knowledge_source_binding()'::regprocedure);
 at_begin:=position(E'BEGIN\n' IN definition);
 IF at_begin=0 THEN RAISE EXCEPTION 'knowledge_binding_guard_schema_changed'; END IF;
 preamble:=$guard$
 IF TG_OP='UPDATE' AND OLD.configured_by_user_id IS NULL AND NEW.configured_by_user_id IS NOT NULL
  AND NOT OLD.binding_held AND NOT NEW.binding_held
  AND NEW.binding_version=OLD.binding_version+1
  AND (OLD.sync_run_id IS NULL OR OLD.sync_lease_until<=clock_timestamp())
  AND (to_jsonb(NEW)-ARRAY['configured_by_user_id','binding_sensitivity','binding_compartments','binding_project_ids','binding_version'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['configured_by_user_id','binding_sensitivity','binding_compartments','binding_project_ids','binding_version'])
  AND EXISTS (
   SELECT 1 FROM public.workspace_knowledge_binding_reviews review
   JOIN public.auth_sessions session ON session.id=review.auth_session_id AND session.user_id=review.actor_user_id
   JOIN public.users actor ON actor.id=session.user_id AND actor.auth_version=session.auth_version
   JOIN public.workspace_members member ON member.workspace_id=review.workspace_id AND member.user_id=review.actor_user_id AND member.role IN('owner','admin')
   JOIN public.workspace_access_policies policy ON policy.workspace_id=review.workspace_id AND policy.revision=review.policy_revision
   JOIN public.workspaces workspace ON workspace.id=review.workspace_id AND workspace.department_read_v2
   JOIN public.workspace_groups department ON department.id=review.target_department_id AND department.workspace_id=review.workspace_id AND department.kind='team' AND department.status='active'
   JOIN public.department_edges edge ON edge.workspace_id=review.workspace_id AND edge.department_id=department.id AND edge.user_id=review.actor_user_id
   WHERE review.id::text=nullif(current_setting('app.knowledge_binding_review',true),'')
    AND review.actor_user_id::text=nullif(current_setting('app.current_user_id',true),'')
    AND review.workspace_id=OLD.workspace_id AND review.source_id=OLD.id
    AND review.status='applying' AND review.expires_at>clock_timestamp()
    AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
    AND (edge.expires_at IS NULL OR edge.expires_at>clock_timestamp())
    AND public.sensitivity_rank(edge.clearance)>=public.sensitivity_rank(NEW.binding_sensitivity)
    AND NEW.configured_by_user_id=review.actor_user_id
    AND NEW.binding_sensitivity=review.evidence->'binding'->>'sensitivity'
    AND to_jsonb(NEW.binding_compartments)=review.evidence->'binding'->'compartments'
    AND NEW.binding_compartments=ARRAY[department.compartment_key]
    AND NEW.binding_project_ids='{}'::uuid[]
    AND review.evidence->>'sourceFingerprint'=encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex')
  ) THEN
   PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE NOWAIT;
   RETURN NEW;
 END IF;
 $guard$;
 EXECUTE substring(definition FROM 1 FOR at_begin+5)||preamble||substring(definition FROM at_begin+6);
END $migration$;
COMMIT;
