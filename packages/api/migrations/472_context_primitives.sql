-- Team audiences, Project registry, and the scope reclassification audit.
-- Spec: docs/architecture/context-engine/scoped-context.md.

BEGIN;

ALTER TABLE public.workspace_groups
  ADD COLUMN kind text NOT NULL DEFAULT 'sharing',
  ADD COLUMN key text,
  ADD COLUMN description text,
  ADD COLUMN color text,
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN compartment_key text,
  ADD COLUMN read_all boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT workspace_groups_kind_check CHECK (kind IN ('sharing', 'team')),
  ADD CONSTRAINT workspace_groups_status_check CHECK (status IN ('active', 'archived')),
  ADD CONSTRAINT workspace_groups_team_shape_check CHECK (
    (kind = 'team') = (key IS NOT NULL AND compartment_key IS NOT NULL)
  ),
  ADD CONSTRAINT workspace_groups_team_compartment_key_check CHECK (
    compartment_key IS NULL OR compartment_key = 'team:' || id::text
  ),
  ADD CONSTRAINT workspace_groups_read_all_team_only CHECK (NOT read_all OR kind = 'team');

CREATE UNIQUE INDEX workspace_groups_team_key_unique
  ON public.workspace_groups (workspace_id, key) WHERE kind = 'team';
CREATE UNIQUE INDEX workspace_groups_compartment_unique
  ON public.workspace_groups (workspace_id, compartment_key)
  WHERE compartment_key IS NOT NULL;
CREATE TRIGGER workspace_groups_set_updated_at
  BEFORE UPDATE ON public.workspace_groups
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.workspace_compartments
  ADD COLUMN managed_by text,
  ADD COLUMN managed_ref_id uuid REFERENCES public.workspace_groups(id) ON DELETE RESTRICT,
  ADD CONSTRAINT workspace_compartments_managed_by_check
    CHECK (managed_by IS NULL OR managed_by = 'team'),
  ADD CONSTRAINT workspace_compartments_managed_pair_check
    CHECK ((managed_by IS NULL) = (managed_ref_id IS NULL));
CREATE UNIQUE INDEX workspace_compartments_managed_ref_unique
  ON public.workspace_compartments (managed_ref_id) WHERE managed_ref_id IS NOT NULL;

CREATE TABLE public.workspace_group_compartment_grants (
  group_id uuid NOT NULL REFERENCES public.workspace_groups(id) ON DELETE CASCADE,
  compartment_key text NOT NULL,
  granted_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, compartment_key)
);

CREATE TABLE public.workspace_group_assistants (
  group_id uuid NOT NULL REFERENCES public.workspace_groups(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES public.assistants(id) ON DELETE CASCADE,
  added_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, assistant_id)
);
CREATE INDEX workspace_group_assistants_assistant_idx
  ON public.workspace_group_assistants (assistant_id, group_id);

CREATE TABLE public.workspace_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  description text,
  icon text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
  CHECK (normalized_name = lower(btrim(name))),
  UNIQUE (workspace_id, normalized_name),
  UNIQUE (workspace_id, id)
);
CREATE INDEX workspace_projects_workspace_status_idx
  ON public.workspace_projects (workspace_id, status, updated_at DESC);
CREATE TRIGGER workspace_projects_set_updated_at
  BEFORE UPDATE ON public.workspace_projects
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE FUNCTION public.prevent_project_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = OLD.workspace_id) THEN
    RAISE EXCEPTION 'Projects archive instead of delete';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER workspace_projects_archive_only
  BEFORE DELETE ON public.workspace_projects
  FOR EACH ROW EXECUTE FUNCTION public.prevent_project_delete();

CREATE FUNCTION public.validate_workspace_project_entity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.entity_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.entities e
     WHERE e.id = NEW.entity_id AND e.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'project entity must stay within the Project workspace';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_projects_entity_workspace_match
  BEFORE INSERT OR UPDATE OF workspace_id, entity_id ON public.workspace_projects
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_project_entity();

CREATE TABLE public.workspace_project_members (
  project_id uuid NOT NULL REFERENCES public.workspace_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX workspace_project_members_user_idx
  ON public.workspace_project_members (user_id, project_id);

CREATE TABLE public.assistant_project_grants (
  assistant_id uuid NOT NULL REFERENCES public.assistants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.workspace_projects(id) ON DELETE CASCADE,
  added_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assistant_id, project_id)
);
CREATE INDEX assistant_project_grants_project_idx
  ON public.assistant_project_grants (project_id, assistant_id);

CREATE TABLE public.context_scope_reclassification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  primitive text NOT NULL CHECK (length(btrim(primitive)) > 0),
  row_id text NOT NULL CHECK (length(btrim(row_id)) > 0),
  previous_compartments text[] NOT NULL DEFAULT '{}',
  next_compartments text[] NOT NULL DEFAULT '{}',
  previous_project_ids uuid[] NOT NULL DEFAULT '{}',
  next_project_ids uuid[] NOT NULL DEFAULT '{}',
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  widening boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_scope_reclassification_row_idx
  ON public.context_scope_reclassification_events
  (workspace_id, primitive, row_id, created_at DESC);

-- Cross-workspace references are rejected in the database. The pinned search
-- path prevents an attacker-controlled schema from shadowing referenced names.
CREATE FUNCTION public.validate_workspace_group_scope_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  group_workspace uuid;
BEGIN
  SELECT workspace_id INTO group_workspace
    FROM public.workspace_groups WHERE id = NEW.group_id;
  IF group_workspace IS NULL THEN
    RAISE EXCEPTION 'context group does not exist';
  END IF;

  IF TG_TABLE_NAME = 'workspace_group_compartment_grants' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_compartments
       WHERE workspace_id = group_workspace AND key = NEW.compartment_key
    ) THEN
      RAISE EXCEPTION 'compartment grant must stay within the group workspace';
    END IF;
  ELSIF TG_TABLE_NAME = 'workspace_group_assistants' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.assistants
       WHERE id = NEW.assistant_id AND workspace_id = group_workspace
    ) THEN
      RAISE EXCEPTION 'assistant grant must stay within the group workspace';
    END IF;
  ELSIF TG_TABLE_NAME = 'workspace_group_members' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_members
       WHERE user_id = NEW.user_id AND workspace_id = group_workspace
    ) THEN
      RAISE EXCEPTION 'group member must belong to the group workspace';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_group_compartment_grants_workspace_match
  BEFORE INSERT OR UPDATE ON public.workspace_group_compartment_grants
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_group_scope_reference();
CREATE TRIGGER workspace_group_assistants_workspace_match
  BEFORE INSERT OR UPDATE ON public.workspace_group_assistants
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_group_scope_reference();
CREATE TRIGGER workspace_group_members_workspace_match
  BEFORE INSERT OR UPDATE ON public.workspace_group_members
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_group_scope_reference();

CREATE FUNCTION public.validate_workspace_project_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  project_workspace uuid;
BEGIN
  SELECT workspace_id INTO project_workspace
    FROM public.workspace_projects WHERE id = NEW.project_id;
  IF project_workspace IS NULL THEN
    RAISE EXCEPTION 'context project does not exist';
  END IF;

  IF TG_TABLE_NAME = 'workspace_project_members' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_members
       WHERE user_id = NEW.user_id AND workspace_id = project_workspace
    ) THEN
      RAISE EXCEPTION 'project participant must belong to the project workspace';
    END IF;
  ELSIF TG_TABLE_NAME = 'assistant_project_grants' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.assistants
       WHERE id = NEW.assistant_id AND workspace_id = project_workspace
    ) THEN
      RAISE EXCEPTION 'assistant Project grant must stay within one workspace';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_project_members_workspace_match
  BEFORE INSERT OR UPDATE ON public.workspace_project_members
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_project_reference();
CREATE TRIGGER assistant_project_grants_workspace_match
  BEFORE INSERT OR UPDATE ON public.assistant_project_grants
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_project_reference();

CREATE FUNCTION public.validate_team_compartment_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.managed_by = 'team' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_groups g
       WHERE g.id = NEW.managed_ref_id
         AND g.workspace_id = NEW.workspace_id
         AND g.kind = 'team'
         AND NEW.key = 'team:' || g.id::text
    ) THEN
      RAISE EXCEPTION 'managed Team compartment must match its Team and workspace';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_compartments_team_binding
  BEFORE INSERT OR UPDATE OF workspace_id, key, managed_by, managed_ref_id
  ON public.workspace_compartments
  FOR EACH ROW EXECUTE FUNCTION public.validate_team_compartment_binding();

CREATE FUNCTION public.prevent_managed_compartment_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF OLD.managed_by = 'team'
     AND EXISTS (SELECT 1 FROM public.workspaces WHERE id = OLD.workspace_id) THEN
    RAISE EXCEPTION 'managed Team compartments are changed through Team settings';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER workspace_compartments_managed_immutable
  BEFORE UPDATE OF workspace_id, key, managed_by, managed_ref_id OR DELETE
  ON public.workspace_compartments
  FOR EACH ROW EXECUTE FUNCTION public.prevent_managed_compartment_mutation();

CREATE FUNCTION public.prevent_team_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF OLD.kind = 'team'
     AND EXISTS (SELECT 1 FROM public.workspaces WHERE id = OLD.workspace_id) THEN
    RAISE EXCEPTION 'Teams archive instead of delete';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER workspace_groups_team_archive_only
  BEFORE DELETE ON public.workspace_groups
  FOR EACH ROW EXECUTE FUNCTION public.prevent_team_delete();

CREATE FUNCTION public.prevent_team_identity_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF OLD.kind = 'team' AND (
    NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.key IS DISTINCT FROM OLD.key OR
    NEW.compartment_key IS DISTINCT FROM OLD.compartment_key OR
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
  ) THEN
    RAISE EXCEPTION 'Team identity and backing compartment are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_groups_team_identity_immutable
  BEFORE UPDATE OF kind, key, compartment_key, workspace_id
  ON public.workspace_groups
  FOR EACH ROW EXECUTE FUNCTION public.prevent_team_identity_change();

-- Member reads; owner/admin mutations. Route authorization remains the first
-- gate, while RLS is the database backstop.
ALTER TABLE public.workspace_group_compartment_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_group_assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_project_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_scope_reclassification_events ENABLE ROW LEVEL SECURITY;

DROP POLICY workspace_groups_member ON public.workspace_groups;
CREATE POLICY workspace_groups_member ON public.workspace_groups
  FOR SELECT USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));
CREATE POLICY workspace_groups_admin ON public.workspace_groups FOR ALL
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
      AND role IN ('owner', 'admin')
  ))
  WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
      AND role IN ('owner', 'admin')
  ));

DROP POLICY workspace_group_members_member ON public.workspace_group_members;
CREATE POLICY workspace_group_members_member ON public.workspace_group_members
  FOR SELECT USING (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
  ));
CREATE POLICY workspace_group_members_admin ON public.workspace_group_members FOR ALL
  USING (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ))
  WITH CHECK (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ));

CREATE POLICY workspace_group_compartment_grants_member
  ON public.workspace_group_compartment_grants
  USING (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
  ));
CREATE POLICY workspace_group_compartment_grants_admin
  ON public.workspace_group_compartment_grants FOR ALL
  USING (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ))
  WITH CHECK (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ));

CREATE POLICY workspace_group_assistants_member ON public.workspace_group_assistants
  USING (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
  ));
CREATE POLICY workspace_group_assistants_admin ON public.workspace_group_assistants FOR ALL
  USING (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ))
  WITH CHECK (group_id IN (
    SELECT g.id FROM public.workspace_groups g
    JOIN public.workspace_members wm ON wm.workspace_id = g.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ));

CREATE POLICY workspace_projects_member ON public.workspace_projects
  FOR SELECT USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));
CREATE POLICY workspace_projects_admin ON public.workspace_projects FOR ALL
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
      AND role IN ('owner', 'admin')
  ))
  WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
      AND role IN ('owner', 'admin')
  ));

CREATE POLICY workspace_project_members_member ON public.workspace_project_members
  FOR SELECT USING (project_id IN (
    SELECT p.id FROM public.workspace_projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
  ));
CREATE POLICY workspace_project_members_admin ON public.workspace_project_members FOR ALL
  USING (project_id IN (
    SELECT p.id FROM public.workspace_projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ))
  WITH CHECK (project_id IN (
    SELECT p.id FROM public.workspace_projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ));

CREATE POLICY assistant_project_grants_member ON public.assistant_project_grants
  FOR SELECT USING (project_id IN (
    SELECT p.id FROM public.workspace_projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
  ));
CREATE POLICY assistant_project_grants_admin ON public.assistant_project_grants FOR ALL
  USING (project_id IN (
    SELECT p.id FROM public.workspace_projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ))
  WITH CHECK (project_id IN (
    SELECT p.id FROM public.workspace_projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      AND wm.role IN ('owner', 'admin')
  ));

CREATE POLICY context_scope_reclassification_member
  ON public.context_scope_reclassification_events FOR SELECT
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));
CREATE POLICY context_scope_reclassification_admin
  ON public.context_scope_reclassification_events FOR INSERT
  WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ) AND actor_user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
