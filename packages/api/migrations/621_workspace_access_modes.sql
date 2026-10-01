-- M1 foundation only: activation/readiness and historical migration are backend commands.
BEGIN;

ALTER TABLE public.workspace_groups ADD CONSTRAINT workspace_groups_workspace_id_id_key UNIQUE(workspace_id,id);
ALTER TABLE public.workspace_access_policies
  ADD COLUMN access_mode text NOT NULL DEFAULT 'departments' CHECK(access_mode IN ('simple','departments')),
  ADD COLUMN default_department_id uuid,
  ADD COLUMN setup_state text NOT NULL DEFAULT 'legacy' CHECK(setup_state IN ('legacy','ready')),
  ADD CONSTRAINT workspace_access_default_local FOREIGN KEY(workspace_id,default_department_id)
    REFERENCES public.workspace_groups(workspace_id,id),
  ADD CONSTRAINT workspace_access_simple_default CHECK(access_mode <> 'simple' OR default_department_id IS NOT NULL);
-- Do not insert policies on workspace creation or change classification_mode.

CREATE FUNCTION public.guard_workspace_access_mode() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM public.workspaces WHERE id=OLD.workspace_id) THEN
      RAISE EXCEPTION 'access_policy_delete_forbidden';
    END IF;
    RETURN OLD;
  END IF;
  -- Canonical writers lock workspace, then policy, then dependent rows. Raw UPDATE
  -- may already hold its target row: deadlocks abort safely and require a retry.
  PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF TG_OP='UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'access_policy_workspace_immutable';
  END IF;
  IF NEW.default_department_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_groups g WHERE g.workspace_id=NEW.workspace_id
      AND g.id=NEW.default_department_id AND g.kind='team' AND g.status='active'
      AND (NEW.access_mode<>'simple' OR (NOT g.read_all AND NOT EXISTS (
        SELECT 1 FROM public.workspace_group_compartment_grants b
        WHERE b.group_id=g.id AND b.compartment_key<>g.compartment_key)))
  ) THEN RAISE EXCEPTION 'access_mode_default_invalid'; END IF;
  -- Revision-only UPSERTs from advance_workspace_access_policy must pass through
  -- unchanged: never reset their increment or recurse into that trigger here.
  IF TG_OP='UPDATE' AND ROW(NEW.access_mode,NEW.default_department_id,NEW.setup_state)
    IS DISTINCT FROM ROW(OLD.access_mode,OLD.default_department_id,OLD.setup_state) THEN
    NEW.revision := OLD.revision+1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_access_mode_guard BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_access_policies
  FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_access_mode();

CREATE FUNCTION public.audit_workspace_access_mode() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- Initializing the compatible legacy policy is not a mode change. Existing
  -- readers and command previews may initialize this row; do not invent an
  -- access-change event for them.
  IF (TG_OP='INSERT' AND (NEW.access_mode<>'departments' OR NEW.default_department_id IS NOT NULL OR NEW.setup_state<>'legacy'))
    OR (TG_OP='UPDATE' AND ROW(NEW.access_mode,NEW.default_department_id,NEW.setup_state)
      IS DISTINCT FROM ROW(OLD.access_mode,OLD.default_department_id,OLD.setup_state)) THEN
    INSERT INTO public.workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes)
    VALUES(NEW.workspace_id,nullif(current_setting('app.current_user_id',true),'')::uuid,
      'workspace.access_mode.set',NEW.workspace_id,NEW.revision,
      jsonb_build_object('before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,'after',to_jsonb(NEW)));
    PERFORM pg_notify('brain_events',json_build_object('workspaceId',NEW.workspace_id,'primitive','workspace_config','action','update')::text);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_access_mode_audit AFTER INSERT OR UPDATE ON public.workspace_access_policies
  FOR EACH ROW EXECUTE FUNCTION public.audit_workspace_access_mode();

CREATE FUNCTION public.guard_workspace_default_package() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE g public.workspace_groups;
BEGIN
  -- Runs after workspace_access_revision (alphabetical BEFORE trigger order),
  -- which serializes package edits on the workspace and advances its policy.
  IF TG_TABLE_NAME='workspace_groups' THEN
    -- Workspace cascades may delete groups before the policy row.
    IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    IF EXISTS(SELECT 1 FROM public.workspace_access_policies p
      WHERE p.workspace_id=OLD.workspace_id AND p.default_department_id=OLD.id) THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'access_mode_default_in_use'; END IF;
      IF NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id OR NEW.kind<>'team' OR NEW.status<>'active'
        OR (NEW.read_all AND EXISTS(SELECT 1 FROM public.workspace_access_policies p
          WHERE p.workspace_id=OLD.workspace_id AND p.access_mode='simple')) THEN
        RAISE EXCEPTION 'access_mode_default_in_use';
      END IF;
    END IF;
  ELSE
    SELECT * INTO g FROM public.workspace_groups WHERE id=NEW.group_id;
    IF NEW.compartment_key<>g.compartment_key AND EXISTS (
      SELECT 1 FROM public.workspace_access_policies p WHERE p.workspace_id=g.workspace_id
        AND p.access_mode='simple' AND p.default_department_id=g.id
    ) THEN RAISE EXCEPTION 'access_mode_default_package_widened'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_workspace_default_guard BEFORE UPDATE OR DELETE ON public.workspace_groups
  FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_default_package();
CREATE TRIGGER zz_workspace_default_guard BEFORE INSERT OR UPDATE ON public.workspace_group_compartment_grants
  FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_default_package();

-- AFTER INSERT is essential: membership validators require the principal to exist,
-- and assistant assigned defaults require the audience grant to exist first.
CREATE FUNCTION public.admit_simple_workspace_principal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE department uuid;
BEGIN
  IF NEW.workspace_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  SELECT default_department_id INTO department FROM public.workspace_access_policies
    WHERE workspace_id=NEW.workspace_id AND access_mode='simple' FOR UPDATE;
  IF department IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='workspace_members' THEN
    INSERT INTO public.workspace_group_members(group_id,user_id) VALUES(department,NEW.user_id)
      ON CONFLICT(group_id,user_id) DO NOTHING;
    UPDATE public.workspace_members SET team_scope_mode='assigned'
      WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id;
  ELSIF NEW.owner_user_id IS NULL OR NEW.kind IN ('primary','app') THEN
    INSERT INTO public.workspace_group_assistants(group_id,assistant_id) VALUES(department,NEW.id)
      ON CONFLICT(group_id,assistant_id) DO NOTHING;
    UPDATE public.assistants SET team_scope_mode='assigned',
      default_workspace_group_id=coalesce(default_workspace_group_id,department)
      WHERE id=NEW.id;
  END IF;
  -- No role, clearance, compartments/direct ceiling, personal ownership, sharing,
  -- Project fields or historical session contexts are changed.
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_simple_member_admission AFTER INSERT ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.admit_simple_workspace_principal();
CREATE TRIGGER workspace_simple_assistant_admission AFTER INSERT ON public.assistants
  FOR EACH ROW EXECUTE FUNCTION public.admit_simple_workspace_principal();

ALTER TABLE public.workspace_access_command_reviews ADD CONSTRAINT workspace_access_command_reviews_workspace_id_id_key UNIQUE(workspace_id,id);
CREATE TABLE public.workspace_access_migration_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  source_mode text NOT NULL CHECK(source_mode IN ('simple','departments')),
  target_mode text NOT NULL CHECK(target_mode IN ('simple','departments')),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','inspected','proposed','awaiting_confirmation','applying','verifying','completed','blocked','stale','paused','cancelled')),
  manifest_revision text NOT NULL CHECK(length(btrim(manifest_revision))>0),
  schema_revision text NOT NULL CHECK(length(btrim(schema_revision))>0),
  policy_revision bigint NOT NULL CHECK(policy_revision>0),
  inventory_revision bigint NOT NULL CHECK(inventory_revision>0),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  intended_population jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(intended_population)='object'),
  summary_counts jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(summary_counts)='object'),
  proposal_hash text NOT NULL CHECK(proposal_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key uuid NOT NULL,
  command_review_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,actor_user_id,idempotency_key),
  FOREIGN KEY(workspace_id,command_review_id) REFERENCES public.workspace_access_command_reviews(workspace_id,id)
);
CREATE UNIQUE INDEX workspace_access_migration_one_active ON public.workspace_access_migration_plans(workspace_id)
  WHERE status NOT IN ('completed','cancelled');

CREATE TABLE public.workspace_access_migration_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK(length(btrim(subject_kind))>0),
  subject_id uuid NOT NULL,
  proposed_action jsonb NOT NULL CHECK(jsonb_typeof(proposed_action)='object'),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  before_state jsonb NOT NULL CHECK(jsonb_typeof(before_state)='object'),
  after_state jsonb NOT NULL CHECK(jsonb_typeof(after_state)='object'),
  evidence_versions jsonb NOT NULL CHECK(jsonb_typeof(evidence_versions)='object'),
  dependency_versions jsonb NOT NULL CHECK(jsonb_typeof(dependency_versions)='object'),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applying','applied','blocked','stale','cancelled')),
  diagnostic_code text CHECK(diagnostic_code ~ '^[a-z][a-z0-9_]{0,99}$'),
  command_review_id uuid,
  scope_review_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,idempotency_key),
  FOREIGN KEY(workspace_id,plan_id) REFERENCES public.workspace_access_migration_plans(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,command_review_id) REFERENCES public.workspace_access_command_reviews(workspace_id,id),
  FOREIGN KEY(workspace_id,scope_review_id) REFERENCES public.workspace_scope_reviews(workspace_id,id)
);
CREATE INDEX workspace_access_migration_items_pending ON public.workspace_access_migration_items(plan_id,status,id);

CREATE FUNCTION public.guard_workspace_access_migration() RETURNS trigger
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
    -- Polymorphic subjects are evidence, never mutation authority. Closed existing
    -- source registry plus explicit principal kinds prevents foreign references.
    IF NEW.subject_kind='member' THEN
      IF NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.subject_id) THEN
        RAISE EXCEPTION 'access_migration_subject_invalid'; END IF;
    ELSIF NEW.subject_kind='assistant' THEN
      IF NOT EXISTS(SELECT 1 FROM public.assistants WHERE workspace_id=NEW.workspace_id AND id=NEW.subject_id) THEN
        RAISE EXCEPTION 'access_migration_subject_invalid'; END IF;
    ELSIF NEW.subject_kind='department' THEN
      IF NOT EXISTS(SELECT 1 FROM public.workspace_groups WHERE workspace_id=NEW.workspace_id AND id=NEW.subject_id AND kind='team') THEN
        RAISE EXCEPTION 'access_migration_subject_invalid'; END IF;
    ELSIF public.scope_source_table(NEW.subject_kind) IS NULL
      OR public.read_scope_source(NEW.workspace_id,NEW.subject_kind,NEW.subject_id) IS NULL THEN
      RAISE EXCEPTION 'access_migration_subject_invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['workspace_access_migration_plans','workspace_access_migration_items'] LOOP
    EXECUTE format('CREATE TRIGGER access_migration_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_access_migration()',tab);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING(workspace_id IN(SELECT workspace_id FROM public.workspace_members WHERE user_id=nullif(current_setting(''app.current_user_id'',true),'''')::uuid AND role IN(''owner'',''admin'')))',tab||'_admin_read',tab);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING(current_setting(''app.system_bypass'',true)=''true'') WITH CHECK(current_setting(''app.system_bypass'',true)=''true'')',tab||'_system',tab);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.guard_workspace_access_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_workspace_access_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_workspace_default_package() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_simple_workspace_principal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_workspace_access_migration() FROM PUBLIC;
COMMIT;
