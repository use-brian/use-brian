-- Persist review ownership so pause/cancel/supersession also govern direct
-- canonical review applies. Keeping only the latest review ID loses this link.
BEGIN;
ALTER TABLE public.workspace_access_migration_items ADD CONSTRAINT access_migration_item_workspace_id_key UNIQUE(workspace_id,id);
CREATE UNIQUE INDEX access_migration_item_review_key ON public.workspace_access_migration_items(workspace_id,(evidence_versions->>'reviewKey'));
CREATE TABLE public.workspace_access_migration_reviews (
  workspace_id uuid NOT NULL,
  review_id uuid PRIMARY KEY,
  item_id uuid NOT NULL,
  FOREIGN KEY(workspace_id,review_id) REFERENCES public.workspace_access_command_reviews(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,item_id) REFERENCES public.workspace_access_migration_items(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE public.workspace_access_migration_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY migration_reviews_admin_read ON public.workspace_access_migration_reviews FOR SELECT USING (
  EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=workspace_access_migration_reviews.workspace_id
    AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND role IN('owner','admin')));
CREATE POLICY migration_reviews_system ON public.workspace_access_migration_reviews FOR ALL
  USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');
INSERT INTO public.workspace_access_migration_reviews(workspace_id,review_id,item_id)
  SELECT i.workspace_id,r.id,i.id FROM public.workspace_access_migration_items i
  JOIN public.workspace_access_migration_plans p ON p.workspace_id=i.workspace_id AND p.id=i.plan_id
  JOIN public.workspace_access_command_reviews r ON r.workspace_id=i.workspace_id AND r.actor_user_id=p.actor_user_id
    AND r.idempotency_key::text=i.evidence_versions->>'reviewKey';

CREATE FUNCTION public.bind_migration_command_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE bound_item public.workspace_access_migration_items; parent public.workspace_access_migration_plans;
BEGIN
  SELECT i.* INTO bound_item FROM public.workspace_access_migration_items i
    JOIN public.workspace_access_migration_plans p ON p.id=i.plan_id AND p.workspace_id=i.workspace_id
    WHERE i.workspace_id=NEW.workspace_id AND p.actor_user_id=NEW.actor_user_id
      AND i.evidence_versions->>'reviewKey'=NEW.idempotency_key::text;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO parent FROM public.workspace_access_migration_plans WHERE id=bound_item.plan_id;
  IF parent.status IN('paused','cancelled','completed') OR parent.expires_at<=clock_timestamp()
    OR bound_item.status='applied' OR bound_item.proposed_action<>NEW.command THEN
    RAISE EXCEPTION 'migration_review_inactive';
  END IF;
  INSERT INTO public.workspace_access_migration_reviews(workspace_id,review_id,item_id)
    VALUES(NEW.workspace_id,NEW.id,bound_item.id);
  RETURN NEW;
END $$;
CREATE TRIGGER migration_command_review_bind AFTER INSERT ON public.workspace_access_command_reviews
  FOR EACH ROW EXECUTE FUNCTION public.bind_migration_command_review();

CREATE FUNCTION public.guard_migration_review_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.status='preview' AND NEW.status='applied' THEN
    PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  END IF;
  IF OLD.status='preview' AND NEW.status='applied' AND EXISTS(
    SELECT 1 FROM public.workspace_access_migration_reviews WHERE review_id=NEW.id
  ) AND NOT EXISTS(
    SELECT 1 FROM public.workspace_access_migration_reviews b
    JOIN public.workspace_access_migration_items i ON i.id=b.item_id AND i.workspace_id=b.workspace_id
    JOIN public.workspace_access_migration_plans p ON p.id=i.plan_id AND p.workspace_id=i.workspace_id
    WHERE b.workspace_id=NEW.workspace_id AND b.review_id=NEW.id
      AND p.actor_user_id=NEW.actor_user_id AND p.status NOT IN('paused','cancelled','completed')
      AND p.expires_at>clock_timestamp() AND i.status<>'applied'
      AND i.evidence_versions->>'reviewKey'=NEW.idempotency_key::text AND i.proposed_action=NEW.command
  ) THEN RAISE EXCEPTION 'migration_review_inactive'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER migration_command_review_apply BEFORE UPDATE ON public.workspace_access_command_reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_migration_review_apply();

CREATE FUNCTION public.guard_migration_review_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.workspaces WHERE id=OLD.workspace_id) THEN
    RAISE EXCEPTION 'migration_review_binding_immutable';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER migration_review_binding_immutable BEFORE UPDATE OR DELETE ON public.workspace_access_migration_reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_migration_review_binding();
REVOKE ALL ON FUNCTION public.bind_migration_command_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_migration_review_apply() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_migration_review_binding() FROM PUBLIC;
COMMIT;
