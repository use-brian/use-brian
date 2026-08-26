-- Principal grants, immutable session context, and effective-member Team SQL.
-- Spec: docs/architecture/context-engine/scoped-context.md.

BEGIN;

ALTER TABLE public.workspace_members
  ADD COLUMN team_scope_mode text NOT NULL DEFAULT 'legacy'
    CHECK (team_scope_mode IN ('legacy', 'assigned'));

ALTER TABLE public.assistants
  ADD COLUMN team_scope_mode text NOT NULL DEFAULT 'legacy'
    CHECK (team_scope_mode IN ('legacy', 'all', 'assigned')),
  ADD COLUMN default_workspace_group_id uuid
    REFERENCES public.workspace_groups(id) ON DELETE SET NULL,
  ADD COLUMN project_scope_mode text NOT NULL DEFAULT 'all'
    CHECK (project_scope_mode IN ('all', 'assigned')),
  ADD COLUMN default_project_id uuid
    REFERENCES public.workspace_projects(id) ON DELETE SET NULL;

ALTER TABLE public.sessions
  ADD COLUMN context_group_id uuid
    REFERENCES public.workspace_groups(id) ON DELETE SET NULL,
  ADD COLUMN context_project_id uuid
    REFERENCES public.workspace_projects(id) ON DELETE SET NULL,
  ADD COLUMN context_compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN context_locked_at timestamptz;
CREATE INDEX sessions_context_group_idx
  ON public.sessions (workspace_id, context_group_id) WHERE context_group_id IS NOT NULL;
CREATE INDEX sessions_context_project_idx
  ON public.sessions (workspace_id, context_project_id) WHERE context_project_id IS NOT NULL;

ALTER TABLE public.brain_keys
  ADD COLUMN context_group_id uuid
    REFERENCES public.workspace_groups(id) ON DELETE SET NULL,
  ADD COLUMN context_project_id uuid
    REFERENCES public.workspace_projects(id) ON DELETE SET NULL;

CREATE FUNCTION public.validate_assistant_context_defaults() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.default_workspace_group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_groups g
     WHERE g.id = NEW.default_workspace_group_id
       AND g.workspace_id = NEW.workspace_id
       AND g.kind = 'team'
  ) THEN
    RAISE EXCEPTION 'assistant default Team must belong to its workspace';
  END IF;
  IF NEW.default_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_projects p
     WHERE p.id = NEW.default_project_id AND p.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'assistant default Project must belong to its workspace';
  END IF;
  IF NEW.team_scope_mode = 'assigned'
     AND NEW.default_workspace_group_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.workspace_group_assistants ga
        WHERE ga.group_id = NEW.default_workspace_group_id
          AND ga.assistant_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'assistant default Team must be inside its assigned Team grant';
  END IF;
  IF NEW.project_scope_mode = 'assigned'
     AND NEW.default_project_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.assistant_project_grants apg
        WHERE apg.project_id = NEW.default_project_id
          AND apg.assistant_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'assistant default Project must be inside its assigned Project grant';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assistants_context_defaults_valid
  BEFORE INSERT OR UPDATE OF workspace_id, team_scope_mode,
    default_workspace_group_id, project_scope_mode, default_project_id
  ON public.assistants
  FOR EACH ROW EXECUTE FUNCTION public.validate_assistant_context_defaults();

CREATE FUNCTION public.validate_session_context_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  backing_key text;
BEGIN
  IF NEW.context_group_id IS NOT NULL THEN
    SELECT g.compartment_key INTO backing_key
      FROM public.workspace_groups g
     WHERE g.id = NEW.context_group_id
       AND g.workspace_id = NEW.workspace_id
       AND g.kind = 'team';
    IF backing_key IS NULL THEN
      RAISE EXCEPTION 'session Team must belong to its workspace';
    END IF;
    IF NEW.context_compartments IS DISTINCT FROM ARRAY[backing_key]::text[] THEN
      RAISE EXCEPTION 'session context_compartments must equal the selected Team backing key';
    END IF;
  ELSIF cardinality(NEW.context_compartments) <> 0 THEN
    RAISE EXCEPTION 'a session without a Team must have an empty context_compartments projection';
  END IF;

  IF NEW.context_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_projects p
     WHERE p.id = NEW.context_project_id AND p.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'session Project must belong to its workspace';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_context_binding_valid
  BEFORE INSERT OR UPDATE OF workspace_id, context_group_id,
    context_project_id, context_compartments
  ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.validate_session_context_binding();

CREATE FUNCTION public.prevent_locked_session_context_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF OLD.context_locked_at IS NOT NULL AND (
    NEW.context_group_id IS DISTINCT FROM OLD.context_group_id OR
    NEW.context_project_id IS DISTINCT FROM OLD.context_project_id OR
    NEW.context_compartments IS DISTINCT FROM OLD.context_compartments
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'context_locked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_context_immutable_after_lock
  BEFORE UPDATE OF context_group_id, context_project_id, context_compartments
  ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_locked_session_context_change();

CREATE FUNCTION public.lock_session_context_on_first_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  UPDATE public.sessions
     SET context_locked_at = COALESCE(context_locked_at, NEW.created_at, now())
   WHERE id = NEW.session_id AND context_locked_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_messages_lock_context
  AFTER INSERT ON public.session_messages
  FOR EACH ROW EXECUTE FUNCTION public.lock_session_context_on_first_message();

CREATE FUNCTION public.validate_brain_key_context_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.context_group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_groups g
     WHERE g.id = NEW.context_group_id
       AND g.workspace_id = NEW.workspace_id
       AND g.kind = 'team'
  ) THEN
    RAISE EXCEPTION 'brain key Team must belong to its workspace';
  END IF;
  IF NEW.context_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_projects p
     WHERE p.id = NEW.context_project_id AND p.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'brain key Project must belong to its workspace';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brain_keys_context_binding_valid
  BEFORE INSERT OR UPDATE OF workspace_id, context_group_id, context_project_id
  ON public.brain_keys
  FOR EACH ROW EXECUTE FUNCTION public.validate_brain_key_context_binding();

-- null = universe. Assigned members receive the flat union of every Team they
-- belong to; a read_all Team is the sole route to universe.
CREATE FUNCTION public.effective_member_team_compartments(
  p_user_id uuid,
  p_workspace_id uuid
) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  member_role text;
  scope_mode text;
  has_read_all boolean;
  result text[];
BEGIN
  SELECT role, team_scope_mode INTO member_role, scope_mode
    FROM public.workspace_members
   WHERE user_id = p_user_id AND workspace_id = p_workspace_id;

  IF member_role IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;
  IF member_role IN ('owner', 'admin') OR scope_mode = 'legacy' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(bool_or(g.read_all), false),
         COALESCE(array_agg(DISTINCT grant_key ORDER BY grant_key)
           FILTER (WHERE grant_key IS NOT NULL), ARRAY[]::text[])
    INTO has_read_all, result
    FROM public.workspace_group_members gm
    JOIN public.workspace_groups g ON g.id = gm.group_id
    LEFT JOIN LATERAL (
      SELECT gcg.compartment_key AS grant_key
        FROM public.workspace_group_compartment_grants gcg
       WHERE gcg.group_id = g.id
    ) grants ON true
   WHERE gm.user_id = p_user_id
     AND g.workspace_id = p_workspace_id
     AND g.kind = 'team';

  IF has_read_all THEN
    RETURN NULL;
  END IF;
  RETURN COALESCE(result, ARRAY[]::text[]);
END;
$$;

COMMIT;
