-- Project shared spaces (foundation): a shared Project owns material guarded by
-- its own roster, through the same row rule that guards Department material.
-- Spec: docs/architecture/features/project-shared-spaces.md (platform);
-- decision source: platform docs/plans/project-shared-spaces-implementation.md
-- D16-D27 and §15.
--
-- Label: `project:<project id>` in the existing requirement arrays
-- (compartments / context_compartments), derived from
-- saved_views.shared_project_id for pages. Migration 650 made non-Department
-- labels restrict nothing; this one makes `project:` labels restrict again.
-- Additive: no existing Project becomes shared, no row is relabelled, and the
-- capability stays off until a workspace owner enables it.
BEGIN;

ALTER TABLE public.workspaces ADD COLUMN project_shared_spaces boolean NOT NULL DEFAULT false;

-- ── State ──────────────────────────────────────────────────────────────────

CREATE TABLE public.project_shared_scopes (
  project_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined')),
  origin text NOT NULL CHECK (origin IN ('created','converted')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES public.workspace_projects(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX project_shared_scopes_workspace_idx ON public.project_shared_scopes(workspace_id);

-- The one roster: people and assistants, no clearance (D22).
CREATE TABLE public.project_shared_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.project_shared_scopes(project_id) ON DELETE CASCADE,
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','assistant')),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  assistant_id uuid REFERENCES public.assistants(id) ON DELETE CASCADE,
  expires_at timestamptz,
  origin text NOT NULL CHECK (origin IN ('creator','invited','converted','recovery','owner')),
  added_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((principal_kind = 'user') = (user_id IS NOT NULL AND assistant_id IS NULL)),
  CHECK ((principal_kind = 'assistant') = (assistant_id IS NOT NULL AND user_id IS NULL))
);
CREATE UNIQUE INDEX project_shared_members_user_unique ON public.project_shared_members(project_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX project_shared_members_assistant_unique ON public.project_shared_members(project_id, assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX project_shared_members_user_idx ON public.project_shared_members(workspace_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX project_shared_members_assistant_idx ON public.project_shared_members(workspace_id, assistant_id) WHERE assistant_id IS NOT NULL;

-- Owners are a governed subset of the roster: every owner holds an edge.
CREATE TABLE public.project_shared_owners (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.project_shared_scopes(project_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE public.project_shared_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.project_shared_scopes(project_id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('provisioned','converted','member_set','member_removed','owner_added',
    'owner_removed','owner_transferred','recovered','status_set','details_updated','archived','restored')),
  principal_kind text CHECK (principal_kind IN ('user','assistant')),
  principal_id uuid,
  before_state jsonb,
  after_state jsonb,
  reason text CHECK (length(reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_shared_audit_events_project_idx ON public.project_shared_audit_events(project_id, created_at);

-- Immutable receipts for reviewed legacy conversions (idempotent replay).
CREATE TABLE public.project_shared_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.workspace_projects(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

-- Pages: a typed Project-shared destination. The placement discriminator
-- (project | teamspace | private) is derived from it and teamspace_id.
ALTER TABLE public.saved_views ADD COLUMN shared_project_id uuid;
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_shared_project_fk
  FOREIGN KEY (shared_project_id) REFERENCES public.project_shared_scopes(project_id) ON DELETE RESTRICT;
CREATE INDEX saved_views_shared_project_idx ON public.saved_views(shared_project_id) WHERE shared_project_id IS NOT NULL;

-- ── Helpers ────────────────────────────────────────────────────────────────

CREATE FUNCTION public.project_member_live(p_project uuid, p_kind text, p_principal uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.project_shared_members e
    WHERE e.project_id = p_project AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())
      AND CASE WHEN p_kind = 'user' THEN e.user_id = p_principal ELSE e.assistant_id = p_principal END)
$$;

-- Who may see a shared Project's registry row, roster, owners and audit:
-- its human roster and the current workspace owner (D18, D26). A legacy
-- Project (no scope row) keeps its existing workspace visibility.
CREATE FUNCTION public.project_shared_audience_allows(p_project uuid, w uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = p_project)
    OR public.project_member_live(p_project, 'user', nullif(current_setting('app.current_user_id', true), '')::uuid)
    OR EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = w AND m.role = 'owner'
                AND m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
$$;

-- The Project leg of the shared map, evaluated without reading a table. Every
-- `project:` label must be in `p`, or (reads only) `o`. A workspace absent
-- from the map admits no Project label.
CREATE FUNCTION public.project_labels_allowed(grants jsonb, w uuid, labels text[], mutation boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(coalesce(labels, '{}'::text[])) AS k
     WHERE k LIKE 'project:%'
       AND NOT (w IS NOT NULL AND coalesce(((grants -> w::text) -> 'p') ? substr(k, 9), false))
       AND NOT (NOT mutation AND w IS NOT NULL AND coalesce(((grants -> w::text) -> 'o') ? substr(k, 9), false)))
$$;

-- ── The row rule (replaces 650) ────────────────────────────────────────────
-- Department labels as in 650. Project labels gate membership (`p`, or `o`
-- for reads) and contribute no tier: a row with no Department label keeps the
-- General eff_base comparison. A bound credential must list every Project.
-- A workspace absent from the map admits no Project-labelled row.
CREATE OR REPLACE FUNCTION public.department_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[], row_user uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN w IS NULL OR NOT (grants ? w::text)
    THEN NOT EXISTS (SELECT 1 FROM unnest(coalesce(compartments, '{}'::text[])) AS k WHERE k LIKE 'project:%')
    ELSE coalesce((
    SELECT public.sensitivity_rank(sensitivity) IS NOT NULL
       AND (row_user IS NULL OR row_user::text = (g.v ->> 'u'))
       AND CASE WHEN ds.ids IS NULL
                THEN public.sensitivity_rank(sensitivity) <= (g.v ->> 'b')::int
                ELSE NOT EXISTS (SELECT 1 FROM unnest(ds.ids) AS d(id)
                                  WHERE NOT coalesce(public.sensitivity_rank(sensitivity) <= ((g.v -> 'd') ->> d.id)::int, false))
           END
       AND (jsonb_typeof(g.v -> 'c') IS DISTINCT FROM 'string' OR ds.ids IS NULL OR (g.v ->> 'c') = ANY (ds.ids))
       AND (jsonb_typeof(g.v -> 'k') IS DISTINCT FROM 'array' OR ds.ids IS NULL
            OR ds.ids <@ ARRAY(SELECT jsonb_array_elements_text(g.v -> 'k')))
       AND (ds.projects IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(ds.projects) AS p(id)
              WHERE NOT (coalesce((g.v -> 'p') ? p.id, false) OR coalesce((g.v -> 'o') ? p.id, false))))
       AND (jsonb_typeof(g.v -> 'k') IS DISTINCT FROM 'array' OR ds.projects IS NULL
            OR ds.projects <@ ARRAY(SELECT jsonb_array_elements_text(g.v -> 'k')))
      FROM (SELECT grants -> w::text AS v) g,
           (SELECT array_agg(substr(k, 6)) FILTER (WHERE k LIKE 'team:%') AS ids,
                   array_agg(substr(k, 9)) FILTER (WHERE k LIKE 'project:%') AS projects
              FROM unnest(coalesce(compartments, '{}'::text[])) AS k) ds
  ), false) END
$$;

-- ── The admission map (replaces 668) ───────────────────────────────────────
-- p: the human and the acting assistant each hold a live roster edge.
-- o: the human is the current workspace owner without an edge, and the acting
--    assistant holds one (D27, read only). Both empty unless the workspace
--    capability is on and the scope is active.
CREATE OR REPLACE FUNCTION department_read_grants_for(p_actor uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH actor AS (
    SELECT p_actor AS u,
           nullif(current_setting('app.v2_assistant_id', true), '')::uuid AS a,
           nullif(current_setting('app.v2_context_department', true), '') AS c,
           nullif(current_setting('app.v2_binding', true), '')::jsonb AS k,
           CASE WHEN nullif(current_setting('app.v2_cap', true), '') IS NULL THEN 3
                ELSE coalesce(sensitivity_rank(current_setting('app.v2_cap', true)), 0) END AS cap
  )
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'b', least(
             sensitivity_rank(CASE WHEN m.role IN ('owner', 'admin') THEN 'confidential' ELSE m.clearance END),
             CASE WHEN actor.a IS NULL THEN 3
                  ELSE coalesce((SELECT sensitivity_rank(x.clearance) FROM assistants x
                                  WHERE x.id = actor.a AND x.workspace_id = m.workspace_id), 0) END,
             actor.cap),
      'd', coalesce((
             SELECT jsonb_object_agg(e.department_id::text, least(
                      sensitivity_rank(e.clearance),
                      CASE WHEN actor.a IS NULL THEN 3 ELSE coalesce(sensitivity_rank(ae.clearance), 0) END,
                      actor.cap))
               FROM department_edges e
               LEFT JOIN department_edges ae
                 ON ae.department_id = e.department_id AND ae.assistant_id = actor.a
                AND (ae.expires_at IS NULL OR ae.expires_at > clock_timestamp())
              WHERE e.workspace_id = m.workspace_id AND e.user_id = actor.u
                AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())), '{}'::jsonb),
      'c', actor.c,
      'k', actor.k,
      'u', actor.u,
      'p', coalesce((
             SELECT jsonb_agg(s.project_id::text ORDER BY s.project_id)
               FROM project_shared_scopes s
              WHERE s.workspace_id = m.workspace_id AND s.status = 'active' AND wk.project_shared_spaces
                AND project_member_live(s.project_id, 'user', actor.u)
                AND (actor.a IS NULL OR project_member_live(s.project_id, 'assistant', actor.a))), '[]'::jsonb),
      'o', coalesce((
             SELECT jsonb_agg(s.project_id::text ORDER BY s.project_id)
               FROM project_shared_scopes s
              WHERE s.workspace_id = m.workspace_id AND s.status = 'active' AND wk.project_shared_spaces
                AND m.role = 'owner'
                AND NOT project_member_live(s.project_id, 'user', actor.u)
                AND (actor.a IS NULL OR project_member_live(s.project_id, 'assistant', actor.a))), '[]'::jsonb))), '{}'::jsonb)
    FROM actor
    JOIN workspace_members m ON m.user_id = actor.u
    JOIN workspaces wk ON wk.id = m.workspace_id AND wk.department_read_v2
   WHERE nullif(current_setting('app.current_user_id', true), '') IS NULL
      OR nullif(current_setting('app.current_user_id', true), '')::uuid = p_actor
$$;
REVOKE ALL ON FUNCTION department_read_grants_for(uuid) FROM PUBLIC;

-- The mutation floor never carries oversight (D27).
CREATE OR REPLACE FUNCTION member_operation_grants(mutation boolean, only_workspace uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH departments AS MATERIALIZED (SELECT department_read_grants() AS grants)
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'r', sensitivity_rank(CASE WHEN m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END),
      'c', to_jsonb(CASE WHEN mutation THEN effective_member_team_compartments(m.user_id, m.workspace_id)
                         ELSE effective_member_read_compartments(m.user_id, m.workspace_id) END),
      'v2', CASE WHEN mutation THEN (departments.grants -> m.workspace_id::text) - 'o'
                 ELSE departments.grants -> m.workspace_id::text END)), '{}'::jsonb)
    FROM workspace_members m CROSS JOIN departments
   WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
     AND (only_workspace IS NULL OR m.workspace_id = only_workspace)
$$;

-- A legacy (non-v2) operation floor admits no Project-labelled row.
CREATE OR REPLACE FUNCTION member_operation_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof((grants -> w::text) -> 'v2') = 'object'
    THEN public.department_row_allows(jsonb_build_object(w::text, (grants -> w::text) -> 'v2'), w, sensitivity, compartments, NULL::uuid)
    ELSE NOT EXISTS (SELECT 1 FROM unnest(coalesce(compartments, '{}'::text[])) AS k WHERE k LIKE 'project:%')
      AND coalesce(
      public.sensitivity_rank(sensitivity) <= ((grants -> w::text) ->> 'r')::int
      AND (jsonb_typeof((grants -> w::text) -> 'c') = 'null'
           OR (NOT (to_jsonb(coalesce(compartments, '{}'::text[])) @> '[null]'::jsonb)
               AND to_jsonb(coalesce(compartments, '{}'::text[])) <@ ((grants -> w::text) -> 'c'))),
      false)
    END
$$;

-- ── Label integrity ────────────────────────────────────────────────────────

-- 474's validator, plus: a `project:` label must name a shared scope in the
-- row workspace.
CREATE OR REPLACE FUNCTION public.validate_context_scope_arrays() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  payload jsonb := to_jsonb(NEW);
  workspace_value uuid;
  compartment_values text[];
  project_values uuid[];
BEGIN
  workspace_value := NULLIF(payload ->> TG_ARGV[0], '')::uuid;
  IF workspace_value IS NULL AND TG_ARGV[0] = 'assistant_workspace' THEN
    SELECT workspace_id INTO workspace_value
      FROM public.assistants WHERE id = (payload ->> 'assistant_id')::uuid;
  END IF;
  compartment_values := COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(payload -> TG_ARGV[1], '[]'::jsonb))),
    ARRAY[]::text[]
  );
  project_values := COALESCE(
    ARRAY(SELECT value::uuid
            FROM jsonb_array_elements_text(COALESCE(payload -> TG_ARGV[2], '[]'::jsonb)) value),
    ARRAY[]::uuid[]
  );

  IF workspace_value IS NULL
     AND (cardinality(compartment_values) > 0 OR cardinality(project_values) > 0) THEN
    RAISE EXCEPTION 'scoped rows require a workspace';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(compartment_values) key
     WHERE key LIKE 'team:%'
       AND NOT EXISTS (
         SELECT 1 FROM public.workspace_compartments wc
          WHERE wc.workspace_id = workspace_value
            AND wc.key = key
            AND wc.managed_by = 'team'
       )
  ) THEN
    RAISE EXCEPTION 'Team requirements must reference managed Teams in the row workspace';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(compartment_values) key
     WHERE key LIKE 'project:%'
       AND NOT EXISTS (
         SELECT 1 FROM public.project_shared_scopes s
          WHERE s.workspace_id = workspace_value AND key = 'project:' || s.project_id::text
       )
  ) THEN
    RAISE EXCEPTION 'project_scope_label_invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(project_values) project_id
     WHERE NOT EXISTS (
       SELECT 1 FROM public.workspace_projects p
        WHERE p.id = project_id AND p.workspace_id = workspace_value
     )
  ) THEN
    RAISE EXCEPTION 'Project requirements must stay within the row workspace';
  END IF;
  RETURN NEW;
END;
$$;

-- 651's home stamp, except a row already carrying a Project label: a chosen
-- Project destination is explicit, like an explicit General choice.
CREATE OR REPLACE FUNCTION public.stamp_department_home() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb := to_jsonb(NEW); home uuid; who_a uuid; who_u uuid;
BEGIN
  IF current_setting('app.explicit_general', true) = 'true' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(NEW.compartments, '{}'::text[])) k WHERE k LIKE 'team:%' OR k LIKE 'project:%') THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = NEW.workspace_id AND (to_jsonb(w) ->> 'department_read_v2')::boolean) THEN
    RETURN NEW;
  END IF;
  who_a := coalesce((r ->> 'created_by_assistant_id')::uuid, (r ->> 'assistant_id')::uuid);
  who_u := coalesce((r ->> 'created_by_user_id')::uuid, (r ->> 'user_id')::uuid);
  IF who_a IS NOT NULL THEN
    SELECT a.home_department_id INTO home FROM public.assistants a WHERE a.id = who_a AND a.workspace_id = NEW.workspace_id;
  END IF;
  IF home IS NULL AND who_u IS NOT NULL THEN
    SELECT m.home_department_id INTO home FROM public.workspace_members m WHERE m.workspace_id = NEW.workspace_id AND m.user_id = who_u;
  END IF;
  IF home IS NOT NULL THEN
    NEW.compartments := array_append(coalesce(NEW.compartments, '{}'::text[]), 'team:' || home::text);
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.validate_project_shared_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = NEW.project_id AND s.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
  IF NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workspace_members m
       WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'project_principal_not_in_workspace';
  END IF;
  IF NEW.assistant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.assistants a
       WHERE a.id = NEW.assistant_id AND a.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'project_principal_not_in_workspace';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER project_shared_members_validate BEFORE INSERT OR UPDATE ON public.project_shared_members
  FOR EACH ROW EXECUTE FUNCTION public.validate_project_shared_member();

CREATE FUNCTION public.validate_project_shared_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = NEW.project_id AND s.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'project_principal_not_in_workspace';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_shared_owners_validate BEFORE INSERT OR UPDATE ON public.project_shared_owners
  FOR EACH ROW EXECUTE FUNCTION public.validate_project_shared_owner();

-- Every owner holds a roster edge with no expiry.
CREATE FUNCTION public.seed_project_shared_owner_edge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.project_shared_members(workspace_id, project_id, principal_kind, user_id, origin, added_by)
  VALUES (NEW.workspace_id, NEW.project_id, 'user', NEW.user_id, 'owner', NEW.added_by)
  ON CONFLICT (project_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET expires_at = NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER project_shared_owners_edge AFTER INSERT ON public.project_shared_owners
  FOR EACH ROW EXECUTE FUNCTION public.seed_project_shared_owner_edge();

-- An owner's edge cannot expire or disappear while the ownership stands.
-- Cascades (user, workspace, scope deleted) pass.
CREATE FUNCTION public.guard_project_shared_owner_edge() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.project_shared_owners o
       WHERE o.project_id = OLD.project_id AND o.user_id = OLD.user_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id)
       AND EXISTS (SELECT 1 FROM public.project_shared_scopes WHERE project_id = OLD.project_id)
       AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = OLD.workspace_id AND m.user_id = OLD.user_id) THEN
      RAISE EXCEPTION 'project_owner_edge_required';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.expires_at IS NOT NULL OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'project_owner_edge_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_shared_members_owner_guard BEFORE UPDATE OR DELETE ON public.project_shared_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_project_shared_owner_edge();

-- At least one owner per shared Project. A cascade from a deleted user,
-- scope or workspace, or a departure from the workspace, is not refused: the
-- workspace owner recovers that orphan (D26).
CREATE FUNCTION public.guard_project_shared_last_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = OLD.project_id)
     AND EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id)
     AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = OLD.workspace_id AND m.user_id = OLD.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.project_shared_owners o
                      JOIN public.workspace_members m ON m.workspace_id = o.workspace_id AND m.user_id = o.user_id
                      WHERE o.project_id = OLD.project_id AND o.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'project_last_owner';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_shared_owners_last_owner BEFORE DELETE OR UPDATE OF project_id, user_id ON public.project_shared_owners
  FOR EACH ROW EXECUTE FUNCTION public.guard_project_shared_last_owner();

-- Leaving the workspace ends every Project edge and ownership there.
CREATE FUNCTION public.project_shared_membership_ended() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.project_shared_owners WHERE workspace_id = OLD.workspace_id AND user_id = OLD.user_id;
  DELETE FROM public.project_shared_members WHERE workspace_id = OLD.workspace_id AND user_id = OLD.user_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.project_shared_membership_ended() FROM PUBLIC;
CREATE TRIGGER project_shared_membership_ended AFTER DELETE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.project_shared_membership_ended();

-- A page inside a Project collection keeps the parent's placement; a move
-- into or out of a collection changes the audience and is refused.
CREATE FUNCTION public.guard_saved_view_shared_project() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent_project uuid; parent_found boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.shared_project_id IS DISTINCT FROM OLD.shared_project_id THEN
    RAISE EXCEPTION 'project_placement_move_refused';
  END IF;
  IF NEW.shared_project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s
       WHERE s.project_id = NEW.shared_project_id AND s.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;
  IF NEW.nest_parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.nest_parent_id IS DISTINCT FROM OLD.nest_parent_id) THEN
    SELECT p.shared_project_id, true INTO parent_project, parent_found FROM public.saved_views p WHERE p.id = NEW.nest_parent_id;
    IF parent_found AND parent_project IS DISTINCT FROM NEW.shared_project_id THEN
      RAISE EXCEPTION 'project_placement_move_refused';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_views_shared_project_guard BEFORE INSERT OR UPDATE OF shared_project_id, nest_parent_id ON public.saved_views
  FOR EACH ROW EXECUTE FUNCTION public.guard_saved_view_shared_project();

-- ── Pages: the Project leg of the 599 functions ─────────────────────────────
-- New signatures carry the shared placement; the 5-argument forms are dropped
-- so no caller can evaluate a page without it.

CREATE FUNCTION saved_view_operation_scope_allows(
  w uuid, page_sensitivity text, page_teamspace uuid, page_project uuid, mutation boolean, shared_project uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  teamspace_sensitivity text;
  compartment text;
  effective_sensitivity text:=page_sensitivity;
  compartments text[]:='{}';
  projects uuid[]:=CASE WHEN page_project IS NULL THEN '{}' ELSE ARRAY[page_project] END;
BEGIN
  IF page_teamspace IS NOT NULL THEN
    SELECT t.sensitivity,g.compartment_key
      INTO teamspace_sensitivity,compartment
      FROM teamspaces t
      LEFT JOIN workspace_groups g
        ON g.id=t.workspace_group_id AND g.workspace_id=t.workspace_id AND g.status='active'
     WHERE t.id=page_teamspace AND t.workspace_id=w;
    IF NOT FOUND THEN RETURN false; END IF;
    IF sensitivity_rank(teamspace_sensitivity)>sensitivity_rank(effective_sensitivity) THEN
      effective_sensitivity:=teamspace_sensitivity;
    END IF;
    IF compartment IS NOT NULL THEN compartments:=ARRAY[compartment]; END IF;
  END IF;
  IF shared_project IS NOT NULL THEN
    compartments:=compartments || ('project:' || shared_project::text);
  END IF;

  RETURN member_operation_scope_allows(w,effective_sensitivity,compartments,mutation)
    AND agent_read_scope_allows(effective_sensitivity,
      ARRAY(SELECT k FROM unnest(compartments) k WHERE k NOT LIKE 'project:%'),projects)
    AND agent_visibility_allows(w,NULL,NULL)
    AND (NOT mutation OR agent_mutation_scope_allows(
      ARRAY(SELECT k FROM unnest(compartments) k WHERE k NOT LIKE 'project:%')));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

CREATE FUNCTION saved_view_principal_boundary_allows(
  w uuid, creator uuid, page_teamspace uuid, page_sensitivity text, page_project uuid, shared_project uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  linked_group uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w AND wm.user_id=actor) THEN
    RETURN false;
  END IF;
  -- A Project-shared page: the Project audience replaces the creator-private
  -- rule; the operation predicate carries the Project and any retained
  -- Department requirement.
  IF shared_project IS NOT NULL THEN
    RETURN saved_view_operation_scope_allows(w,page_sensitivity,page_teamspace,page_project,false,shared_project);
  END IF;
  IF page_teamspace IS NULL THEN RETURN creator=actor; END IF;
  SELECT t.workspace_group_id INTO linked_group FROM teamspaces t
    WHERE t.id=page_teamspace AND t.workspace_id=w;
  IF NOT FOUND THEN RETURN false; END IF;
  IF linked_group IS NOT NULL THEN
    RETURN saved_view_operation_scope_allows(w,page_sensitivity,page_teamspace,page_project,false,NULL);
  END IF;
  RETURN EXISTS(SELECT 1 FROM teamspace_members tm
    WHERE tm.teamspace_id=page_teamspace AND tm.user_id=actor)
    OR (nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
      AND saved_view_operation_scope_allows(w,page_sensitivity,page_teamspace,page_project,false,NULL));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION saved_view_root_operation_scope_allows(p_page uuid, mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM saved_views sv WHERE sv.id=p_page
      AND saved_view_principal_boundary_allows(
        sv.workspace_id,sv.created_by,sv.teamspace_id,sv.clearance,sv.project_id,sv.shared_project_id)
      AND saved_view_operation_scope_allows(
        sv.workspace_id,sv.clearance,sv.teamspace_id,sv.project_id,mutation,sv.shared_project_id)
  )
$$;

ALTER POLICY saved_views_workspace_member ON saved_views
  USING (saved_view_principal_boundary_allows(
    workspace_id,created_by,teamspace_id,clearance,project_id,shared_project_id));
ALTER POLICY saved_view_operation_read ON saved_views
  USING (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,false,shared_project_id));
ALTER POLICY saved_view_operation_insert ON saved_views
  WITH CHECK (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true,shared_project_id));
ALTER POLICY saved_view_operation_update ON saved_views
  USING (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true,shared_project_id))
  WITH CHECK (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true,shared_project_id));
ALTER POLICY saved_view_operation_delete ON saved_views
  USING (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true,shared_project_id));

DROP FUNCTION saved_view_principal_boundary_allows(uuid, uuid, uuid, text, uuid);
DROP FUNCTION saved_view_operation_scope_allows(uuid, text, uuid, uuid, boolean);

-- ── Sessions: the Project leg ──────────────────────────────────────────────
-- A shared Project chat is a workspace session labelled `project:<id>`; the
-- legacy-style workspace policies (owner/admin universe) must not reach it.
CREATE POLICY sessions_project_scope ON sessions AS RESTRICTIVE FOR ALL
  USING (project_labels_allowed((SELECT department_read_grants()), workspace_id, context_compartments, false))
  WITH CHECK (project_labels_allowed((SELECT department_read_grants()), workspace_id, context_compartments, true));

CREATE FUNCTION public.session_project_labels_allowed(p_session uuid, mutation boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT public.project_labels_allowed(public.department_read_grants(), s.workspace_id, s.context_compartments, mutation)
                     FROM public.sessions s WHERE s.id = p_session), true)
$$;
CREATE POLICY session_messages_project_scope ON session_messages AS RESTRICTIVE FOR ALL
  USING (session_project_labels_allowed(session_id, false))
  WITH CHECK (session_project_labels_allowed(session_id, true));

-- A workspace-audience session bound to a shared Project is a shared Project
-- chat: it carries the Project label (D24). Personal sessions bound to the
-- same Project stay personal and unlabelled. Until the first message locks the
-- context, a changed binding drops the stale Project label.
CREATE FUNCTION public.stamp_session_project_label() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.context_locked_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.context_project_id IS DISTINCT FROM OLD.context_project_id THEN
    NEW.context_compartments := ARRAY(SELECT k FROM unnest(coalesce(NEW.context_compartments, '{}'::text[])) k
      WHERE k NOT LIKE 'project:%' OR k = 'project:' || NEW.context_project_id::text);
  END IF;
  IF NEW.visibility = 'workspace' AND NEW.context_project_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = NEW.context_project_id AND s.workspace_id = NEW.workspace_id)
     AND NOT (('project:' || NEW.context_project_id::text) = ANY (coalesce(NEW.context_compartments, '{}'::text[]))) THEN
    NEW.context_compartments := array_append(coalesce(NEW.context_compartments, '{}'::text[]), 'project:' || NEW.context_project_id::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aaab_session_project_label BEFORE INSERT OR UPDATE OF context_project_id, visibility ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_session_project_label();

-- 473's binding validator, plus: the bound shared Project's own label is the
-- one permitted addition to the Team projection; any other Project label is
-- refused.
CREATE OR REPLACE FUNCTION public.validate_session_context_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  backing_key text;
  project_label text := CASE WHEN NEW.context_project_id IS NULL THEN NULL ELSE 'project:' || NEW.context_project_id::text END;
  team_labels text[];
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(coalesce(NEW.context_compartments, '{}'::text[])) k
              WHERE k LIKE 'project:%' AND (k IS DISTINCT FROM project_label OR NOT EXISTS (
                SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = NEW.context_project_id AND s.workspace_id = NEW.workspace_id))) THEN
    RAISE EXCEPTION 'session Project label must name its bound shared Project';
  END IF;
  team_labels := ARRAY(SELECT k FROM unnest(coalesce(NEW.context_compartments, '{}'::text[])) k WHERE k NOT LIKE 'project:%');
  IF NEW.context_group_id IS NOT NULL THEN
    SELECT g.compartment_key INTO backing_key
      FROM public.workspace_groups g
     WHERE g.id = NEW.context_group_id
       AND g.workspace_id = NEW.workspace_id
       AND g.kind = 'team';
    IF backing_key IS NULL THEN
      RAISE EXCEPTION 'session Team must belong to its workspace';
    END IF;
    IF team_labels IS DISTINCT FROM ARRAY[backing_key]::text[] THEN
      RAISE EXCEPTION 'session context_compartments must equal the selected Team backing key';
    END IF;
  ELSIF cardinality(team_labels) <> 0 THEN
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

-- 594's projection lifetime, plus the viewer's expiring shared Project edges.
CREATE OR REPLACE FUNCTION department_media_valid_for_ms(p_workspace_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH actor AS (
    SELECT nullif(current_setting('app.current_user_id',true),'')::uuid AS id
  ), boundaries AS (
    SELECT now()+interval '30 seconds' AS boundary
    UNION ALL
    SELECT point FROM workspace_access_grants g
      CROSS JOIN LATERAL unnest(ARRAY[g.starts_at,g.expires_at]) AS point
      WHERE g.workspace_id=p_workspace_id AND g.revoked_at IS NULL AND point>now()
        AND can_view_department_request(g.request_id,(SELECT id FROM actor))
    UNION ALL
    SELECT request_expires_at FROM workspace_access_requests r
      WHERE r.workspace_id=p_workspace_id AND r.status='pending' AND r.request_expires_at>now()
        AND can_view_department_request(r.id,(SELECT id FROM actor))
    UNION ALL
    SELECT e.expires_at FROM project_shared_members e
      WHERE e.workspace_id=p_workspace_id AND e.user_id=(SELECT id FROM actor) AND e.expires_at>now()
  ) SELECT CASE WHEN EXISTS (
      SELECT 1 FROM workspace_members m WHERE m.workspace_id=p_workspace_id AND m.user_id=(SELECT id FROM actor)
    ) THEN greatest(0,floor(extract(epoch FROM (min(boundary)-clock_timestamp()))*1000))::integer
      ELSE 0 END FROM boundaries
$$;

-- ── Registry visibility (D18, D26) ─────────────────────────────────────────
CREATE POLICY workspace_projects_shared_audience ON public.workspace_projects AS RESTRICTIVE FOR ALL
  USING (public.project_shared_audience_allows(id, workspace_id))
  WITH CHECK (true);

ALTER TABLE public.project_shared_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_shared_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_shared_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_shared_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_shared_conversions ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_shared_scopes_audience ON public.project_shared_scopes FOR SELECT
  USING (public.project_shared_audience_allows(project_id, workspace_id));
CREATE POLICY project_shared_members_audience ON public.project_shared_members FOR SELECT
  USING (public.project_shared_audience_allows(project_id, workspace_id));
CREATE POLICY project_shared_owners_audience ON public.project_shared_owners FOR SELECT
  USING (public.project_shared_audience_allows(project_id, workspace_id));
CREATE POLICY project_shared_audit_audience ON public.project_shared_audit_events FOR SELECT
  USING (public.project_shared_audience_allows(project_id, workspace_id));
CREATE POLICY project_shared_conversions_owner ON public.project_shared_conversions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = project_shared_conversions.workspace_id
    AND m.role = 'owner' AND m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid));

-- ── Commands (actor = app.current_user_id; lock workspace, then scope) ─────

CREATE FUNCTION public.project_shared_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'project_actor_required'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION public.project_shared_lock(p_project uuid, OUT workspace_id uuid, OUT revision bigint, OUT status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE w uuid;
BEGIN
  SELECT s.workspace_id INTO w FROM public.project_shared_scopes s WHERE s.project_id = p_project;
  IF w IS NULL THEN RAISE EXCEPTION 'project_not_found'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = w FOR UPDATE;
  SELECT s.revision, s.status INTO revision, status FROM public.project_shared_scopes s WHERE s.project_id = p_project FOR UPDATE;
  workspace_id := w;
END $$;

CREATE FUNCTION public.project_shared_bump(p_project uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.project_shared_scopes SET revision = revision + 1, updated_at = now() WHERE project_id = p_project RETURNING revision
$$;

CREATE FUNCTION public.project_shared_check_revision(p_current bigint, p_expected bigint) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_expected IS NOT NULL AND p_expected <> p_current THEN RAISE EXCEPTION 'project_revision_stale'; END IF;
END $$;

-- A Project owner: the owner row AND a live workspace membership. No
-- workspace role substitutes for it. A non-member sees `project_not_found`.
CREATE FUNCTION public.project_shared_require_owner(p_project uuid, p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.project_shared_owners o
                   JOIN public.workspace_members m ON m.workspace_id = o.workspace_id AND m.user_id = o.user_id
                  WHERE o.project_id = p_project AND o.user_id = p_actor) THEN
    IF public.project_member_live(p_project, 'user', p_actor) THEN RAISE EXCEPTION 'project_owner_required'; END IF;
    RAISE EXCEPTION 'project_not_found';
  END IF;
END $$;

CREATE FUNCTION public.project_shared_require_workspace_owner(w uuid, p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = w AND m.user_id = p_actor AND m.role = 'owner') THEN
    RAISE EXCEPTION 'project_recovery_owner_only';
  END IF;
END $$;

CREATE FUNCTION public.project_shared_check_principal(w uuid, p_kind text, p_principal uuid, p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_kind = 'user' AND NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = w AND user_id = p_principal) THEN
    RAISE EXCEPTION 'project_principal_not_in_workspace';
  ELSIF p_kind = 'assistant' AND NOT EXISTS (SELECT 1 FROM public.assistants a WHERE a.workspace_id = w AND a.id = p_principal
          AND public.assistant_placement_visible(p_actor, a.id)) THEN
    RAISE EXCEPTION 'project_assistant_unavailable';
  ELSIF p_kind NOT IN ('user','assistant') THEN
    RAISE EXCEPTION 'project_principal_invalid';
  END IF;
END $$;

CREATE FUNCTION public.project_shared_audit(w uuid, p_project uuid, p_actor uuid, p_action text, p_kind text,
  p_principal uuid, p_before jsonb, p_after jsonb, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.project_shared_audit_events(workspace_id, project_id, actor_user_id, action, principal_kind, principal_id, before_state, after_state, reason)
  VALUES (w, p_project, p_actor, p_action, p_kind, p_principal, p_before, p_after, p_reason)
$$;

CREATE FUNCTION public.project_shared_owner_set(p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(o.user_id::text ORDER BY o.user_id), '[]'::jsonb) FROM public.project_shared_owners o WHERE o.project_id = p_project
$$;

-- Create a shared Project with its restricted scope, creator ownership and the
-- visibly selected participants, atomically (D17, D20, D21, D23). Existing
-- creation authority: workspace owner or admin.
CREATE FUNCTION public.project_shared_create(p_workspace uuid, p_name text, p_description text, p_icon text,
  p_user_ids uuid[], p_assistant_ids uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); project uuid := gen_random_uuid(); v_name text := btrim(p_name); x uuid;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id = p_workspace FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace AND m.user_id = actor AND m.role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'project_create_not_allowed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace AND w.project_shared_spaces AND w.department_read_v2) THEN
    RAISE EXCEPTION 'project_shared_disabled';
  END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'project_name_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM public.workspace_projects p WHERE p.workspace_id = p_workspace AND p.normalized_name = lower(v_name)) THEN
    RAISE EXCEPTION 'project_name_taken';
  END IF;
  FOREACH x IN ARRAY coalesce(p_user_ids, '{}') LOOP PERFORM public.project_shared_check_principal(p_workspace, 'user', x, actor); END LOOP;
  FOREACH x IN ARRAY coalesce(p_assistant_ids, '{}') LOOP PERFORM public.project_shared_check_principal(p_workspace, 'assistant', x, actor); END LOOP;
  INSERT INTO public.workspace_projects(id, workspace_id, name, normalized_name, description, icon, created_by)
  VALUES (project, p_workspace, v_name, lower(v_name), nullif(btrim(coalesce(p_description, '')), ''), nullif(btrim(coalesce(p_icon, '')), ''), actor);
  INSERT INTO public.project_shared_scopes(project_id, workspace_id, origin, created_by) VALUES (project, p_workspace, 'created', actor);
  INSERT INTO public.project_shared_owners(workspace_id, project_id, user_id, added_by) VALUES (p_workspace, project, actor, actor);
  UPDATE public.project_shared_members SET origin = 'creator' WHERE project_id = project AND user_id = actor;
  INSERT INTO public.project_shared_members(workspace_id, project_id, principal_kind, user_id, origin, added_by)
  SELECT DISTINCT p_workspace, project, 'user', u, 'invited', actor FROM unnest(coalesce(p_user_ids, '{}')) u WHERE u <> actor
  ON CONFLICT (project_id, user_id) WHERE user_id IS NOT NULL DO NOTHING;
  INSERT INTO public.project_shared_members(workspace_id, project_id, principal_kind, assistant_id, origin, added_by)
  SELECT DISTINCT p_workspace, project, 'assistant', a, 'invited', actor FROM unnest(coalesce(p_assistant_ids, '{}')) a
  ON CONFLICT (project_id, assistant_id) WHERE assistant_id IS NOT NULL DO NOTHING;
  PERFORM public.project_shared_audit(p_workspace, project, actor, 'provisioned', NULL, NULL, NULL,
    jsonb_build_object('owners', public.project_shared_owner_set(project),
      'users', (SELECT coalesce(jsonb_agg(user_id::text ORDER BY user_id), '[]') FROM public.project_shared_members WHERE project_id = project AND user_id IS NOT NULL),
      'assistants', (SELECT coalesce(jsonb_agg(assistant_id::text ORDER BY assistant_id), '[]') FROM public.project_shared_members WHERE project_id = project AND assistant_id IS NOT NULL)));
  RETURN project;
END $$;

-- Add a person or assistant, or change an expiry. No clearance (D22).
CREATE FUNCTION public.project_shared_set_member(p_project uuid, p_kind text, p_principal uuid, p_expires_at timestamptz, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record; cur record;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_owner(p_project, actor);
  PERFORM public.project_shared_check_principal(lk.workspace_id, p_kind, p_principal, actor);
  IF p_expires_at IS NOT NULL AND p_expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'project_expiry_invalid'; END IF;
  SELECT e.expires_at INTO cur FROM public.project_shared_members e
   WHERE e.project_id = p_project AND CASE WHEN p_kind = 'user' THEN e.user_id = p_principal ELSE e.assistant_id = p_principal END FOR UPDATE;
  IF FOUND AND cur.expires_at IS NOT DISTINCT FROM p_expires_at THEN RETURN lk.revision; END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  IF p_kind = 'user' THEN
    INSERT INTO public.project_shared_members(workspace_id, project_id, principal_kind, user_id, expires_at, origin, added_by)
    VALUES (lk.workspace_id, p_project, 'user', p_principal, p_expires_at, 'invited', actor)
    ON CONFLICT (project_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET expires_at = EXCLUDED.expires_at;
  ELSE
    INSERT INTO public.project_shared_members(workspace_id, project_id, principal_kind, assistant_id, expires_at, origin, added_by)
    VALUES (lk.workspace_id, p_project, 'assistant', p_principal, p_expires_at, 'invited', actor)
    ON CONFLICT (project_id, assistant_id) WHERE assistant_id IS NOT NULL DO UPDATE SET expires_at = EXCLUDED.expires_at;
  END IF;
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, 'member_set', p_kind, p_principal,
    CASE WHEN cur IS NULL THEN NULL ELSE jsonb_build_object('expiresAt', cur.expires_at) END, jsonb_build_object('expiresAt', p_expires_at));
  RETURN public.project_shared_bump(p_project);
END $$;

CREATE FUNCTION public.project_shared_remove_member(p_project uuid, p_kind text, p_principal uuid, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record; cur record;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_owner(p_project, actor);
  SELECT e.id, e.expires_at INTO cur FROM public.project_shared_members e
   WHERE e.project_id = p_project AND CASE WHEN p_kind = 'user' THEN e.user_id = p_principal ELSE e.assistant_id = p_principal END FOR UPDATE;
  IF NOT FOUND THEN RETURN lk.revision; END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  DELETE FROM public.project_shared_members WHERE id = cur.id;
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, 'member_removed', p_kind, p_principal,
    jsonb_build_object('expiresAt', cur.expires_at), NULL);
  RETURN public.project_shared_bump(p_project);
END $$;

CREATE FUNCTION public.project_shared_add_owner(p_project uuid, p_user uuid, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record; before jsonb;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_owner(p_project, actor);
  PERFORM public.project_shared_check_principal(lk.workspace_id, 'user', p_user, actor);
  IF EXISTS (SELECT 1 FROM public.project_shared_owners WHERE project_id = p_project AND user_id = p_user) THEN RETURN lk.revision; END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  before := public.project_shared_owner_set(p_project);
  INSERT INTO public.project_shared_owners(workspace_id, project_id, user_id, added_by) VALUES (lk.workspace_id, p_project, p_user, actor);
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, 'owner_added', 'user', p_user,
    jsonb_build_object('owners', before), jsonb_build_object('owners', public.project_shared_owner_set(p_project)));
  RETURN public.project_shared_bump(p_project);
END $$;

CREATE FUNCTION public.project_shared_remove_owner(p_project uuid, p_user uuid, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record; before jsonb;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_owner(p_project, actor);
  IF NOT EXISTS (SELECT 1 FROM public.project_shared_owners WHERE project_id = p_project AND user_id = p_user) THEN RETURN lk.revision; END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  before := public.project_shared_owner_set(p_project);
  DELETE FROM public.project_shared_owners WHERE project_id = p_project AND user_id = p_user;
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, 'owner_removed', 'user', p_user,
    jsonb_build_object('owners', before), jsonb_build_object('owners', public.project_shared_owner_set(p_project)));
  RETURN public.project_shared_bump(p_project);
END $$;

-- Add the target as owner and remove the actor as owner, atomically. The
-- actor keeps an ordinary roster edge.
CREATE FUNCTION public.project_shared_transfer_owner(p_project uuid, p_user uuid, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record; before jsonb;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_owner(p_project, actor);
  PERFORM public.project_shared_check_principal(lk.workspace_id, 'user', p_user, actor);
  IF p_user = actor THEN RETURN lk.revision; END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  before := public.project_shared_owner_set(p_project);
  INSERT INTO public.project_shared_owners(workspace_id, project_id, user_id, added_by) VALUES (lk.workspace_id, p_project, p_user, actor)
  ON CONFLICT DO NOTHING;
  DELETE FROM public.project_shared_owners WHERE project_id = p_project AND user_id = actor;
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, 'owner_transferred', 'user', p_user,
    jsonb_build_object('owners', before), jsonb_build_object('owners', public.project_shared_owner_set(p_project)));
  RETURN public.project_shared_bump(p_project);
END $$;

-- D26: the current workspace owner recovers ownership of any shared Project,
-- at any time, for themself or an explicitly selected workspace member.
-- Existing owners and participants stay; no assistant is re-enrolled.
CREATE FUNCTION public.project_shared_recover(p_project uuid, p_target uuid, p_reason text, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record; target uuid := coalesce(p_target, actor); before jsonb;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_workspace_owner(lk.workspace_id, actor);
  PERFORM public.project_shared_check_principal(lk.workspace_id, 'user', target, actor);
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'project_recovery_reason_required'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_shared_owners WHERE project_id = p_project AND user_id = target) THEN RETURN lk.revision; END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  before := public.project_shared_owner_set(p_project);
  INSERT INTO public.project_shared_owners(workspace_id, project_id, user_id, added_by) VALUES (lk.workspace_id, p_project, target, actor);
  UPDATE public.project_shared_members SET origin = 'recovery' WHERE project_id = p_project AND user_id = target AND origin = 'owner';
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, 'recovered', 'user', target,
    jsonb_build_object('owners', before), jsonb_build_object('owners', public.project_shared_owner_set(p_project)), p_reason);
  RETURN public.project_shared_bump(p_project);
END $$;

-- Workspace owner: quarantine (unavailable to everyone) or reactivate.
CREATE FUNCTION public.project_shared_set_status(p_project uuid, p_status text, p_reason text, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_workspace_owner(lk.workspace_id, actor);
  IF p_status NOT IN ('active','quarantined') THEN RAISE EXCEPTION 'project_status_invalid'; END IF;
  IF lk.status = p_status THEN RETURN lk.revision; END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  UPDATE public.project_shared_scopes SET status = p_status WHERE project_id = p_project;
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, 'status_set', NULL, NULL,
    jsonb_build_object('status', lk.status), jsonb_build_object('status', p_status), p_reason);
  RETURN public.project_shared_bump(p_project);
END $$;

-- Registry details of a shared Project: its owners edit them.
CREATE FUNCTION public.project_shared_update_details(p_project uuid, p_name text, p_description text, p_icon text, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record; cur record; v_name text;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_owner(p_project, actor);
  SELECT p.name AS old_name, p.description AS old_description, p.icon AS old_icon INTO cur FROM public.workspace_projects p WHERE p.id = p_project;
  v_name := coalesce(btrim(p_name), cur.old_name);
  IF length(v_name) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'project_name_invalid'; END IF;
  IF lower(v_name) <> lower(cur.old_name) AND EXISTS (SELECT 1 FROM public.workspace_projects p
       WHERE p.workspace_id = lk.workspace_id AND p.normalized_name = lower(v_name) AND p.id <> p_project) THEN
    RAISE EXCEPTION 'project_name_taken';
  END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  UPDATE public.workspace_projects p SET name = v_name, normalized_name = lower(v_name),
         description = CASE WHEN p_description IS NULL THEN cur.old_description ELSE nullif(btrim(p_description), '') END,
         icon = CASE WHEN p_icon IS NULL THEN cur.old_icon ELSE nullif(btrim(p_icon), '') END, updated_at = now()
   WHERE p.id = p_project;
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, 'details_updated', NULL, NULL,
    jsonb_build_object('name', cur.old_name), jsonb_build_object('name', v_name));
  RETURN public.project_shared_bump(p_project);
END $$;

-- Archive pauses bound unattended work (projects.md); restore never restarts it.
CREATE FUNCTION public.project_shared_archive(p_project uuid, p_archived boolean, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); lk record; cur text;
BEGIN
  SELECT * INTO lk FROM public.project_shared_lock(p_project);
  PERFORM public.project_shared_require_owner(p_project, actor);
  SELECT p.status INTO cur FROM public.workspace_projects p WHERE p.id = p_project;
  IF (cur = 'archived') = p_archived THEN RETURN lk.revision; END IF;
  PERFORM public.project_shared_check_revision(lk.revision, p_expected_revision);
  UPDATE public.workspace_projects SET status = CASE WHEN p_archived THEN 'archived' ELSE 'active' END, updated_at = now() WHERE id = p_project;
  IF p_archived THEN
    UPDATE public.workflows SET enabled = false, paused_reason = 'project_archived', updated_at = now()
     WHERE workspace_id = lk.workspace_id AND context_project_id = p_project AND enabled = true;
    UPDATE public.scheduled_jobs SET enabled = false, last_status = 'project_archived', updated_at = now()
     WHERE context_project_id = p_project AND enabled = true;
  END IF;
  PERFORM public.project_shared_audit(lk.workspace_id, p_project, actor, CASE WHEN p_archived THEN 'archived' ELSE 'restored' END,
    NULL, NULL, jsonb_build_object('status', cur), jsonb_build_object('status', CASE WHEN p_archived THEN 'archived' ELSE 'active' END));
  RETURN public.project_shared_bump(p_project);
END $$;

-- Reviewed legacy conversion (§15.3). The caller passes the exact reviewed
-- roster and the preview hash; nothing comes from old participation metadata.
-- Conversion relabels no material. A repeat of the same request returns its
-- stored receipt.
CREATE FUNCTION public.project_shared_convert(p_project uuid, p_owner uuid, p_user_ids uuid[], p_assistant_ids uuid[],
  p_idempotency_key uuid, p_request_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor(); w uuid; prior record; x uuid; v_receipt jsonb; owner_user uuid := coalesce(p_owner, actor);
BEGIN
  SELECT p.workspace_id INTO w FROM public.workspace_projects p WHERE p.id = p_project;
  IF w IS NULL THEN RAISE EXCEPTION 'project_not_found'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = w FOR UPDATE;
  PERFORM public.project_shared_require_workspace_owner(w, actor);
  SELECT c.request_hash, c.receipt INTO prior FROM public.project_shared_conversions c WHERE c.workspace_id = w AND c.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF prior.request_hash <> p_request_hash THEN RAISE EXCEPTION 'project_idempotency_conflict'; END IF;
    RETURN prior.receipt || jsonb_build_object('replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces wk WHERE wk.id = w AND wk.project_shared_spaces AND wk.department_read_v2) THEN
    RAISE EXCEPTION 'project_shared_disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = p_project) THEN RAISE EXCEPTION 'project_already_shared'; END IF;
  PERFORM public.project_shared_check_principal(w, 'user', owner_user, actor);
  FOREACH x IN ARRAY coalesce(p_user_ids, '{}') LOOP PERFORM public.project_shared_check_principal(w, 'user', x, actor); END LOOP;
  FOREACH x IN ARRAY coalesce(p_assistant_ids, '{}') LOOP PERFORM public.project_shared_check_principal(w, 'assistant', x, actor); END LOOP;
  INSERT INTO public.project_shared_scopes(project_id, workspace_id, origin, created_by) VALUES (p_project, w, 'converted', actor);
  INSERT INTO public.project_shared_owners(workspace_id, project_id, user_id, added_by) VALUES (w, p_project, owner_user, actor);
  INSERT INTO public.project_shared_members(workspace_id, project_id, principal_kind, user_id, origin, added_by)
  SELECT DISTINCT w, p_project, 'user', u, 'converted', actor FROM unnest(coalesce(p_user_ids, '{}')) u
  ON CONFLICT (project_id, user_id) WHERE user_id IS NOT NULL DO NOTHING;
  INSERT INTO public.project_shared_members(workspace_id, project_id, principal_kind, assistant_id, origin, added_by)
  SELECT DISTINCT w, p_project, 'assistant', a, 'converted', actor FROM unnest(coalesce(p_assistant_ids, '{}')) a
  ON CONFLICT (project_id, assistant_id) WHERE assistant_id IS NOT NULL DO NOTHING;
  v_receipt := jsonb_build_object('projectId', p_project, 'revision', 1, 'owners', public.project_shared_owner_set(p_project),
    'users', (SELECT coalesce(jsonb_agg(user_id::text ORDER BY user_id), '[]') FROM public.project_shared_members WHERE project_id = p_project AND user_id IS NOT NULL),
    'assistants', (SELECT coalesce(jsonb_agg(assistant_id::text ORDER BY assistant_id), '[]') FROM public.project_shared_members WHERE project_id = p_project AND assistant_id IS NOT NULL),
    'relabelled', 0, 'replayed', false);
  PERFORM public.project_shared_audit(w, p_project, actor, 'converted', 'user', owner_user, NULL, v_receipt);
  INSERT INTO public.project_shared_conversions(workspace_id, project_id, actor_user_id, idempotency_key, request_hash, receipt)
  VALUES (w, p_project, actor, p_idempotency_key, p_request_hash, v_receipt);
  RETURN v_receipt;
END $$;

-- Workspace owner enables or disables shared spaces. Disabling keeps every
-- scope, roster and label; Project-labelled material becomes unavailable.
CREATE FUNCTION public.project_shared_set_capability(p_workspace uuid, p_enabled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.project_shared_actor();
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id = p_workspace FOR UPDATE;
  PERFORM public.project_shared_require_workspace_owner(p_workspace, actor);
  IF p_enabled AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace AND w.department_read_v2) THEN
    RAISE EXCEPTION 'project_shared_requires_department_read';
  END IF;
  UPDATE public.workspaces SET project_shared_spaces = p_enabled WHERE id = p_workspace;
  RETURN p_enabled;
END $$;

REVOKE ALL ON FUNCTION public.project_shared_lock(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.project_shared_bump(uuid) FROM PUBLIC;

SELECT public.crm_install_erasure_capture();

COMMIT;
