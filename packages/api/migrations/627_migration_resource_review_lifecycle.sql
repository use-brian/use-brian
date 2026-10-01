-- Durable bindings survive supersession; preview and binding are committed together.
BEGIN;
-- Resource item identity uses the canonical review registry, including held and
-- impact-only roots. Provenance-source eligibility is intentionally narrower and
-- is not the authority for a durable administrator review binding.
CREATE OR REPLACE FUNCTION public.guard_workspace_access_migration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id THEN RAISE EXCEPTION 'access_migration_identity_immutable'; END IF;
    NEW.version:=OLD.version+1;
    NEW.updated_at:=now();
  END IF;
  IF TG_TABLE_NAME='workspace_access_migration_plans' THEN
    IF TG_OP='UPDATE' AND ROW(NEW.actor_user_id,NEW.idempotency_key,NEW.source_mode,NEW.target_mode)
      IS DISTINCT FROM ROW(OLD.actor_user_id,OLD.idempotency_key,OLD.source_mode,OLD.target_mode) THEN
      RAISE EXCEPTION 'access_migration_identity_immutable';
    END IF;
    IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id
      AND user_id=NEW.actor_user_id AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'access_migration_admin_required';
    END IF;
  ELSE
    IF TG_OP='UPDATE' THEN
      IF ROW(NEW.plan_id,NEW.subject_kind,NEW.subject_id,NEW.idempotency_key)
        IS DISTINCT FROM ROW(OLD.plan_id,OLD.subject_kind,OLD.subject_id,OLD.idempotency_key) THEN
        RAISE EXCEPTION 'access_migration_identity_immutable';
      END IF;
      -- A deleted subject must still be checkpointable as stale/cancelled.
      RETURN NEW;
    END IF;
    -- Polymorphic subjects are evidence, never mutation authority. Resource
    -- reviews use the review registry; other subjects retain their original gates.
    IF NEW.subject_kind='member' THEN
      IF NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.subject_id) THEN
        RAISE EXCEPTION 'access_migration_subject_invalid'; END IF;
    ELSIF NEW.subject_kind='assistant' THEN
      IF NOT EXISTS(SELECT 1 FROM public.assistants WHERE workspace_id=NEW.workspace_id AND id=NEW.subject_id) THEN
        RAISE EXCEPTION 'access_migration_subject_invalid'; END IF;
    ELSIF NEW.subject_kind='department' THEN
      IF NOT EXISTS(SELECT 1 FROM public.workspace_groups WHERE workspace_id=NEW.workspace_id AND id=NEW.subject_id AND kind='team') THEN
        RAISE EXCEPTION 'access_migration_subject_invalid'; END IF;
    ELSIF (CASE WHEN NEW.proposed_action->>'type'='resource.scope' THEN
      public.read_scope_review_source(NEW.workspace_id,NEW.subject_kind,NEW.subject_id) IS NULL
      ELSE public.scope_source_table(NEW.subject_kind) IS NULL
        OR public.read_scope_source(NEW.workspace_id,NEW.subject_kind,NEW.subject_id) IS NULL END) THEN
      RAISE EXCEPTION 'access_migration_subject_invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.workspace_access_migration_resource_reviews (
  workspace_id uuid NOT NULL,
  review_id uuid PRIMARY KEY,
  item_id uuid NOT NULL,
  review_key uuid NOT NULL,
  expected_version bigint NOT NULL CHECK(expected_version>0),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(workspace_id,review_id) REFERENCES public.workspace_scope_reviews(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,item_id) REFERENCES public.workspace_access_migration_items(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE public.workspace_access_migration_resource_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY migration_resource_reviews_admin_read ON public.workspace_access_migration_resource_reviews FOR SELECT USING (
  EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=workspace_access_migration_resource_reviews.workspace_id
    AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND role IN('owner','admin')));
CREATE POLICY migration_resource_reviews_system ON public.workspace_access_migration_resource_reviews FOR ALL
  USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');
CREATE TRIGGER migration_resource_binding_immutable BEFORE UPDATE OR DELETE ON public.workspace_access_migration_resource_reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_migration_review_binding();

CREATE FUNCTION public.guard_migration_resource_review_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.status<>'applied' AND NEW.status='applied' THEN
    PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.workspace_access_migration_resource_reviews WHERE review_id=NEW.review_id)
      AND NOT EXISTS(
        SELECT 1 FROM public.workspace_access_migration_resource_reviews b
        JOIN public.workspace_access_migration_items i ON i.workspace_id=b.workspace_id AND i.id=b.item_id
        JOIN public.workspace_access_migration_plans p ON p.workspace_id=i.workspace_id AND p.id=i.plan_id
        JOIN public.workspace_scope_reviews r ON r.workspace_id=b.workspace_id AND r.id=b.review_id
        WHERE b.workspace_id=NEW.workspace_id AND b.review_id=NEW.review_id
          AND p.status NOT IN('paused','cancelled','completed') AND p.expires_at>clock_timestamp()
          AND b.expires_at>clock_timestamp() AND i.status<>'applied'
          AND i.scope_review_id=b.review_id AND i.evidence_versions->>'reviewKey'=b.review_key::text
          AND r.created_by=p.actor_user_id AND r.version=b.expected_version
          AND p.actor_user_id::text=current_setting('app.scope_review_actor',true)
          AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=p.workspace_id
            AND m.user_id=p.actor_user_id AND m.role IN('owner','admin'))
          AND i.proposed_action->>'type'='resource.scope'
          AND i.proposed_action->>'resourceKind'=r.resource_kind
          AND i.proposed_action->>'resourceId'=NEW.resource_id::text
          AND i.proposed_action->>'action'=r.action
          AND (i.proposed_action->>'targetTeamId') IS NOT DISTINCT FROM r.target_team_id::text
          AND i.reason=r.reason
          -- Do not allow a newly attached or predecessor provenance floor to
          -- turn an older migration binding into unrestricted declassification.
          AND (r.action<>'consolidate_default' OR NOT EXISTS(
            SELECT 1 FROM public.scope_derivations d WHERE d.workspace_id=i.workspace_id
              AND d.resource_kind=i.subject_kind
              AND d.resource_id IN(SELECT resource_id FROM public.scope_source_ancestors(i.workspace_id,i.subject_kind,i.subject_id))
              AND NOT d.compartments <@ ARRAY[r.target_compartment]))
      ) THEN RAISE EXCEPTION 'migration_review_inactive'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER migration_resource_review_apply BEFORE UPDATE ON public.workspace_scope_review_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_migration_resource_review_apply();
REVOKE ALL ON FUNCTION public.guard_migration_resource_review_apply() FROM PUBLIC;
COMMIT;
