-- Permission model v2, Phase 1 (additive): department owners and the one
-- membership edge (principal, department, clearance, expires_at?).
-- Spec: platform docs/plans/permission-model-v2.md §3, §4, §5, §12.4 item 1;
-- docs/architecture/features/workspace-access.md -> "Department edges (v2)".
--
-- Nothing on a live read path reads these tables until the Phase 2 flag flips.
-- The edges live in their own table rather than as extra rows in
-- workspace_group_members: legacy resolvers read that table's rows, so a
-- migrated owner/admin edge, a read-grant edge or a bundle edge written there
-- would widen legacy rosters and reach before the flip.
BEGIN;

CREATE TABLE public.department_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  department_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','assistant')),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  assistant_id uuid REFERENCES public.assistants(id) ON DELETE CASCADE,
  clearance text NOT NULL CHECK (clearance IN ('public','internal','confidential')),
  expires_at timestamptz,
  -- Where the edge came from. 'migrated' marks reach a legacy owner/admin or
  -- universe/bundle/read_all member had without a real membership; owners
  -- review those after cutover. 'store' is an edge a department owner set.
  origin text NOT NULL CHECK (origin IN ('member','migrated','grant','assistant','primary','owner','store')),
  added_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, department_id) REFERENCES public.workspace_groups(workspace_id, id) ON DELETE CASCADE,
  CHECK ((principal_kind = 'user') = (user_id IS NOT NULL AND assistant_id IS NULL)),
  CHECK ((principal_kind = 'assistant') = (assistant_id IS NOT NULL AND user_id IS NULL))
);
CREATE UNIQUE INDEX department_edges_user_unique ON public.department_edges(department_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX department_edges_assistant_unique ON public.department_edges(department_id, assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX department_edges_user_idx ON public.department_edges(workspace_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX department_edges_assistant_idx ON public.department_edges(workspace_id, assistant_id) WHERE assistant_id IS NOT NULL;

CREATE TABLE public.department_owners (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  department_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, user_id),
  FOREIGN KEY (workspace_id, department_id) REFERENCES public.workspace_groups(workspace_id, id) ON DELETE CASCADE
);

-- One revision per department: every edge or owner mutation advances it, and a
-- caller presenting an older one fails (I17).
CREATE TABLE public.department_revisions (
  department_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (workspace_id, department_id) REFERENCES public.workspace_groups(workspace_id, id) ON DELETE CASCADE
);

-- Visible to the department's members (I3: break-glass is audited where its
-- members can see it).
CREATE TABLE public.department_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  department_id uuid NOT NULL,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('edge_set','edge_removed','owner_added','owner_removed','break_glass')),
  principal_kind text CHECK (principal_kind IN ('user','assistant')),
  principal_id uuid,
  before_state jsonb,
  after_state jsonb,
  reason text CHECK (length(reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, department_id) REFERENCES public.workspace_groups(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX department_audit_events_department_idx ON public.department_audit_events(department_id, created_at);

-- Credentials read with the issuer's edges (D13). Backfilled from created_by.
ALTER TABLE public.brain_keys ADD COLUMN issuer_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.api_keys ADD COLUMN issuer_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- ── Reads ─────────────────────────────────────────────────────────────────

-- clearance_in(P, D) of §4: an unexpired edge's clearance, else NULL ("none").
-- Expired is identical to missing (I6).
CREATE FUNCTION public.department_clearance_in(p_kind text, p_principal uuid, p_department uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.clearance FROM public.department_edges e
   WHERE e.department_id = p_department
     AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())
     AND CASE WHEN p_kind = 'user' THEN e.user_id = p_principal ELSE e.assistant_id = p_principal END
$$;

CREATE FUNCTION public.department_clearance_rank(p_clearance text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_clearance WHEN 'public' THEN 1 WHEN 'internal' THEN 2 WHEN 'confidential' THEN 3 ELSE 0 END
$$;

-- ── Integrity ─────────────────────────────────────────────────────────────

CREATE FUNCTION public.validate_department_edge() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspace_groups g
                  WHERE g.id = NEW.department_id AND g.workspace_id = NEW.workspace_id AND g.kind = 'team') THEN
    RAISE EXCEPTION 'department_not_found';
  END IF;
  IF NEW.assistant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.assistants a
       WHERE a.id = NEW.assistant_id AND a.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'department_principal_not_in_workspace';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER department_edges_validate BEFORE INSERT OR UPDATE ON public.department_edges
  FOR EACH ROW EXECUTE FUNCTION public.validate_department_edge();

CREATE FUNCTION public.validate_department_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspace_groups g
                  WHERE g.id = NEW.department_id AND g.workspace_id = NEW.workspace_id AND g.kind = 'team') THEN
    RAISE EXCEPTION 'department_not_found';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER department_owners_validate BEFORE INSERT OR UPDATE ON public.department_owners
  FOR EACH ROW EXECUTE FUNCTION public.validate_department_owner();

-- Every owner of D holds confidential in D, with no expiry (§3).
CREATE FUNCTION public.seed_department_owner_edge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.department_edges(workspace_id, department_id, principal_kind, user_id, clearance, origin, added_by)
  VALUES (NEW.workspace_id, NEW.department_id, 'user', NEW.user_id, 'confidential', 'owner', NEW.added_by)
  ON CONFLICT (department_id, user_id) WHERE user_id IS NOT NULL
  DO UPDATE SET clearance = 'confidential', expires_at = NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER department_owners_edge AFTER INSERT ON public.department_owners
  FOR EACH ROW EXECUTE FUNCTION public.seed_department_owner_edge();

-- An owner's edge cannot drop below confidential, expire, or disappear while
-- the ownership stands. Cascades (user, workspace or department deleted) pass:
-- the parent row is already gone in this transaction.
CREATE FUNCTION public.guard_department_owner_edge() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.department_owners o
       WHERE o.department_id = OLD.department_id AND o.user_id = OLD.user_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id)
       AND EXISTS (SELECT 1 FROM public.workspace_groups WHERE id = OLD.department_id) THEN
      RAISE EXCEPTION 'department_owner_edge_required';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.clearance <> 'confidential' OR NEW.expires_at IS NOT NULL
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.department_id <> OLD.department_id THEN
    RAISE EXCEPTION 'department_owner_edge_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER department_edges_owner_guard BEFORE UPDATE OR DELETE ON public.department_edges
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_owner_edge();

-- At least one owner per active department. Removing the last owner directly
-- is refused; a cascade from a deleted user, department or workspace is not.
CREATE FUNCTION public.guard_department_last_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workspace_groups g
              WHERE g.id = OLD.department_id AND g.kind = 'team' AND g.status = 'active')
     AND EXISTS (SELECT 1 FROM public.workspaces WHERE id = OLD.workspace_id)
     AND EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.department_owners o
                      WHERE o.department_id = OLD.department_id AND o.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'department_last_owner';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER department_owners_last_owner BEFORE DELETE OR UPDATE OF department_id, user_id ON public.department_owners
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_last_owner();

-- Credential issuer: stamped from created_by at insert, never rewritten except
-- by the users FK's ON DELETE SET NULL.
CREATE FUNCTION public.stamp_credential_issuer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.issuer_user_id := coalesce(NEW.issuer_user_id, NEW.created_by);
  ELSIF NEW.issuer_user_id IS DISTINCT FROM OLD.issuer_user_id AND NEW.issuer_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'credential_issuer_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_keys_issuer BEFORE INSERT OR UPDATE OF issuer_user_id ON public.brain_keys
  FOR EACH ROW EXECUTE FUNCTION public.stamp_credential_issuer();
CREATE TRIGGER api_keys_issuer BEFORE INSERT OR UPDATE OF issuer_user_id ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.stamp_credential_issuer();

-- ── Backfill (idempotent, resumable per workspace; I19) ────────────────────

-- Legacy assistant Team reach, as context-scope-store resolves it:
-- 'all' = every Team; 'legacy' = assistants.compartments (NULL = every Team);
-- 'assigned' = assigned Teams plus their bundles, read_all = every Team,
-- intersected with assistants.compartments when that is set.
CREATE FUNCTION public.legacy_assistant_team_compartments(p_assistant uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a record; assigned text[]; wildcard boolean;
BEGIN
  SELECT team_scope_mode, compartments, workspace_id INTO a FROM public.assistants WHERE id = p_assistant;
  IF a IS NULL THEN RETURN ARRAY[]::text[]; END IF;
  IF a.team_scope_mode = 'all' THEN RETURN NULL; END IF;
  IF a.team_scope_mode = 'legacy' THEN RETURN a.compartments; END IF;
  SELECT coalesce(bool_or(g.read_all), false),
         coalesce(array_agg(DISTINCT k) FILTER (WHERE k IS NOT NULL), ARRAY[]::text[])
    INTO wildcard, assigned
    FROM public.workspace_group_assistants ga
    JOIN public.workspace_groups g ON g.id = ga.group_id AND g.workspace_id = a.workspace_id AND g.kind = 'team'
    LEFT JOIN LATERAL (SELECT g.compartment_key AS k
                       UNION SELECT gcg.compartment_key FROM public.workspace_group_compartment_grants gcg
                        WHERE gcg.group_id = g.id) keys ON true
   WHERE ga.assistant_id = p_assistant;
  IF wildcard THEN RETURN NULL; END IF;
  IF a.compartments IS NOT NULL THEN
    RETURN ARRAY(SELECT x FROM unnest(assigned) x WHERE x = ANY(a.compartments) ORDER BY x);
  END IF;
  RETURN assigned;
END $$;

-- Rebuilds every derived edge of one workspace from its legacy state. Edges
-- an owner set ('store') and owner edges are never touched by a rerun; derived
-- edges whose legacy source disappeared are removed. Safe to run any number
-- of times, workspace by workspace.
CREATE FUNCTION public.department_edges_reconcile(p_workspace uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.department_revisions(department_id, workspace_id)
  SELECT g.id, g.workspace_id FROM public.workspace_groups g
   WHERE g.workspace_id = p_workspace AND g.kind = 'team'
  ON CONFLICT (department_id) DO NOTHING;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.derived_edges (
    department_id uuid, principal_kind text, principal uuid, clearance text, expires_at timestamptz, origin text
  ) ON COMMIT DROP;
  DELETE FROM pg_temp.derived_edges;

  -- Humans: exactly the Teams legacy resolution reaches (NULL = every Team).
  INSERT INTO pg_temp.derived_edges
  SELECT g.id, 'user', m.user_id,
         CASE WHEN m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END,
         NULL,
         CASE WHEN EXISTS (SELECT 1 FROM public.workspace_group_members gm WHERE gm.group_id = g.id AND gm.user_id = m.user_id)
              THEN 'member' ELSE 'migrated' END
    FROM public.workspace_members m
    CROSS JOIN LATERAL (SELECT public.effective_member_team_compartments(m.user_id, m.workspace_id) AS reach) r
    JOIN public.workspace_groups g ON g.workspace_id = m.workspace_id AND g.kind = 'team'
   WHERE m.workspace_id = p_workspace
     AND (r.reach IS NULL OR g.compartment_key = ANY(r.reach));

  -- Live read grants become expiring edges where no edge exists yet.
  INSERT INTO pg_temp.derived_edges
  SELECT DISTINCT ON (gr.target_team_id, b.user_id)
         gr.target_team_id, 'user', b.user_id, m.clearance, gr.expires_at, 'grant'
    FROM public.workspace_access_grants gr
    CROSS JOIN LATERAL (
      SELECT gr.beneficiary_id AS user_id WHERE gr.beneficiary_kind = 'member'
      UNION SELECT gm.user_id FROM public.workspace_group_members gm
       WHERE gr.beneficiary_kind = 'team' AND gm.group_id = gr.beneficiary_id) b
    JOIN public.workspace_members m ON m.workspace_id = gr.workspace_id AND m.user_id = b.user_id
   WHERE gr.workspace_id = p_workspace AND gr.revoked_at IS NULL
     AND gr.starts_at <= now() AND (gr.expires_at IS NULL OR gr.expires_at > now())
     AND NOT EXISTS (SELECT 1 FROM pg_temp.derived_edges d
                      WHERE d.department_id = gr.target_team_id AND d.principal = b.user_id)
   ORDER BY gr.target_team_id, b.user_id, gr.expires_at DESC NULLS FIRST;

  -- Assistants: the primary auto-joins every department at confidential (D12);
  -- every other assistant gets the Teams its legacy scope reaches.
  INSERT INTO pg_temp.derived_edges
  SELECT g.id, 'assistant', a.id,
         CASE WHEN a.kind = 'primary' THEN 'confidential' ELSE a.clearance END,
         NULL,
         CASE WHEN a.kind = 'primary' THEN 'primary' ELSE 'assistant' END
    FROM public.assistants a
    CROSS JOIN LATERAL (SELECT CASE WHEN a.kind = 'primary' THEN NULL
                                    ELSE public.legacy_assistant_team_compartments(a.id) END AS reach) r
    JOIN public.workspace_groups g ON g.workspace_id = a.workspace_id AND g.kind = 'team'
   WHERE a.workspace_id = p_workspace
     AND (r.reach IS NULL OR g.compartment_key = ANY(r.reach));

  -- Drop derived edges whose source is gone; owner and store edges stay.
  DELETE FROM public.department_edges e
   WHERE e.workspace_id = p_workspace
     AND e.origin IN ('member','migrated','grant','assistant','primary')
     AND NOT EXISTS (SELECT 1 FROM pg_temp.derived_edges d
                      WHERE d.department_id = e.department_id
                        AND d.principal = coalesce(e.user_id, e.assistant_id))
     AND NOT EXISTS (SELECT 1 FROM public.department_owners o
                      WHERE o.department_id = e.department_id AND o.user_id = e.user_id);

  INSERT INTO public.department_edges(workspace_id, department_id, principal_kind, user_id, assistant_id, clearance, expires_at, origin)
  SELECT p_workspace, d.department_id, d.principal_kind,
         CASE WHEN d.principal_kind = 'user' THEN d.principal END,
         CASE WHEN d.principal_kind = 'assistant' THEN d.principal END,
         d.clearance, d.expires_at, d.origin
    FROM pg_temp.derived_edges d WHERE d.principal_kind = 'user'
  ON CONFLICT (department_id, user_id) WHERE user_id IS NOT NULL DO UPDATE
     SET clearance = EXCLUDED.clearance, expires_at = EXCLUDED.expires_at, origin = EXCLUDED.origin
   WHERE department_edges.origin IN ('member','migrated','grant')
     AND NOT EXISTS (SELECT 1 FROM public.department_owners o
                      WHERE o.department_id = department_edges.department_id AND o.user_id = department_edges.user_id);
  INSERT INTO public.department_edges(workspace_id, department_id, principal_kind, assistant_id, clearance, origin)
  SELECT p_workspace, d.department_id, 'assistant', d.principal, d.clearance, d.origin
    FROM pg_temp.derived_edges d WHERE d.principal_kind = 'assistant'
  ON CONFLICT (department_id, assistant_id) WHERE assistant_id IS NOT NULL DO UPDATE
     SET clearance = EXCLUDED.clearance, origin = EXCLUDED.origin
   WHERE department_edges.origin IN ('assistant','primary');

  -- Owners: every live Team manager, else the creating admin while still a
  -- member, else the workspace owner. A department with none of these stays
  -- orphaned and is recovered by the workspace owner's break-glass.
  INSERT INTO public.department_owners(workspace_id, department_id, user_id)
  SELECT tm.workspace_id, tm.team_id, tm.user_id FROM public.workspace_team_managers tm
    JOIN public.workspace_members m ON m.workspace_id = tm.workspace_id AND m.user_id = tm.user_id
   WHERE tm.workspace_id = p_workspace AND tm.revoked_at IS NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO public.department_owners(workspace_id, department_id, user_id)
  SELECT g.workspace_id, g.id,
         coalesce((SELECT m.user_id FROM public.workspace_members m
                    WHERE m.workspace_id = g.workspace_id AND m.user_id = g.created_by),
                  (SELECT m.user_id FROM public.workspace_members m
                    WHERE m.workspace_id = g.workspace_id AND m.role = 'owner' ORDER BY m.joined_at, m.user_id LIMIT 1))
    FROM public.workspace_groups g
   WHERE g.workspace_id = p_workspace AND g.kind = 'team'
     AND NOT EXISTS (SELECT 1 FROM public.department_owners o WHERE o.department_id = g.id)
     AND coalesce((SELECT m.user_id FROM public.workspace_members m
                    WHERE m.workspace_id = g.workspace_id AND m.user_id = g.created_by),
                  (SELECT m.user_id FROM public.workspace_members m
                    WHERE m.workspace_id = g.workspace_id AND m.role = 'owner' LIMIT 1)) IS NOT NULL
  ON CONFLICT DO NOTHING;
END $$;

-- A Team created after this migration gets its creator as first owner and the
-- workspace primary assistant's confidential edge (§5, D12). Writes only v2
-- tables; the Team's legacy behaviour is untouched.
CREATE FUNCTION public.seed_new_department() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.kind <> 'team' THEN RETURN NEW; END IF;
  INSERT INTO public.department_revisions(department_id, workspace_id) VALUES (NEW.id, NEW.workspace_id)
  ON CONFLICT (department_id) DO NOTHING;
  INSERT INTO public.department_owners(workspace_id, department_id, user_id, added_by)
  VALUES (NEW.workspace_id, NEW.id, NEW.created_by, NEW.created_by) ON CONFLICT DO NOTHING;
  INSERT INTO public.department_edges(workspace_id, department_id, principal_kind, assistant_id, clearance, origin)
  SELECT NEW.workspace_id, NEW.id, 'assistant', a.id, 'confidential', 'primary'
    FROM public.assistants a WHERE a.workspace_id = NEW.workspace_id AND a.kind = 'primary'
  ON CONFLICT (department_id, assistant_id) WHERE assistant_id IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_seed_new_department AFTER INSERT ON public.workspace_groups
  FOR EACH ROW EXECUTE FUNCTION public.seed_new_department();

-- ── Mutations (§5; I4, I5, I17) ───────────────────────────────────────────
-- The actor is always app.current_user_id. Lock order is workspace, then the
-- department's revision row, matching the workspace-first admission writers.

CREATE FUNCTION public.department_lock(p_department uuid, p_expected bigint, OUT workspace_id uuid, OUT revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE w uuid;
BEGIN
  SELECT g.workspace_id INTO w FROM public.workspace_groups g
   WHERE g.id = p_department AND g.kind = 'team' AND g.status = 'active';
  IF w IS NULL THEN RAISE EXCEPTION 'department_not_found'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = w FOR UPDATE;
  INSERT INTO public.department_revisions(department_id, workspace_id) VALUES (p_department, w)
  ON CONFLICT (department_id) DO NOTHING;
  SELECT r.revision INTO revision FROM public.department_revisions r WHERE r.department_id = p_department FOR UPDATE;
  workspace_id := w;
END $$;

CREATE FUNCTION public.department_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'department_actor_required'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION public.department_require_owner(p_department uuid, p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- Ownership is held through the owner row AND a live workspace membership;
  -- no workspace role substitutes for it (P4, P9).
  IF NOT EXISTS (SELECT 1 FROM public.department_owners o
                   JOIN public.workspace_members m ON m.workspace_id = o.workspace_id AND m.user_id = o.user_id
                  WHERE o.department_id = p_department AND o.user_id = p_actor) THEN
    RAISE EXCEPTION 'department_owner_required';
  END IF;
END $$;

CREATE FUNCTION public.department_bump(p_department uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.department_revisions SET revision = revision + 1 WHERE department_id = p_department RETURNING revision
$$;

CREATE FUNCTION public.department_check_principal(p_workspace uuid, p_kind text, p_principal uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_kind = 'user' AND NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = p_workspace AND user_id = p_principal) THEN
    RAISE EXCEPTION 'department_principal_not_in_workspace';
  ELSIF p_kind = 'assistant' AND NOT EXISTS (SELECT 1 FROM public.assistants WHERE workspace_id = p_workspace AND id = p_principal) THEN
    RAISE EXCEPTION 'department_principal_not_in_workspace';
  ELSIF p_kind NOT IN ('user','assistant') THEN
    RAISE EXCEPTION 'department_principal_invalid';
  END IF;
END $$;

-- Add a human or assistant to D, or change its clearance or expiry. The actor
-- must own D and may not grant above their own clearance in D (I4). Setting
-- the state that already holds is a successful no-op on any revision (I17).
CREATE FUNCTION public.department_set_edge(p_department uuid, p_kind text, p_principal uuid, p_clearance text,
  p_expires_at timestamptz, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.department_actor(); lk record; cur record; next_revision bigint;
BEGIN
  SELECT * INTO lk FROM public.department_lock(p_department, p_expected_revision);
  PERFORM public.department_require_owner(p_department, actor);
  PERFORM public.department_check_principal(lk.workspace_id, p_kind, p_principal);
  IF public.department_clearance_rank(p_clearance) = 0 THEN RAISE EXCEPTION 'department_clearance_invalid'; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'department_expiry_invalid'; END IF;
  IF public.department_clearance_rank(p_clearance)
     > public.department_clearance_rank(public.department_clearance_in('user', actor, p_department)) THEN
    RAISE EXCEPTION 'department_clearance_above_own';
  END IF;
  SELECT e.clearance, e.expires_at INTO cur FROM public.department_edges e
   WHERE e.department_id = p_department
     AND CASE WHEN p_kind = 'user' THEN e.user_id = p_principal ELSE e.assistant_id = p_principal END
   FOR UPDATE;
  IF FOUND AND cur.clearance = p_clearance AND cur.expires_at IS NOT DISTINCT FROM p_expires_at THEN
    RETURN lk.revision;
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> lk.revision THEN
    RAISE EXCEPTION 'department_revision_stale';
  END IF;
  IF p_kind = 'user' THEN
    INSERT INTO public.department_edges(workspace_id, department_id, principal_kind, user_id, clearance, expires_at, origin, added_by)
    VALUES (lk.workspace_id, p_department, 'user', p_principal, p_clearance, p_expires_at, 'store', actor)
    ON CONFLICT (department_id, user_id) WHERE user_id IS NOT NULL
    DO UPDATE SET clearance = EXCLUDED.clearance, expires_at = EXCLUDED.expires_at, origin = 'store', added_by = EXCLUDED.added_by;
  ELSE
    INSERT INTO public.department_edges(workspace_id, department_id, principal_kind, assistant_id, clearance, expires_at, origin, added_by)
    VALUES (lk.workspace_id, p_department, 'assistant', p_principal, p_clearance, p_expires_at, 'store', actor)
    ON CONFLICT (department_id, assistant_id) WHERE assistant_id IS NOT NULL
    DO UPDATE SET clearance = EXCLUDED.clearance, expires_at = EXCLUDED.expires_at, origin = 'store', added_by = EXCLUDED.added_by;
  END IF;
  next_revision := public.department_bump(p_department);
  INSERT INTO public.department_audit_events(workspace_id, department_id, actor_user_id, action, principal_kind, principal_id, before_state, after_state)
  VALUES (lk.workspace_id, p_department, actor, 'edge_set', p_kind, p_principal,
    CASE WHEN cur IS NULL THEN NULL ELSE jsonb_build_object('clearance', cur.clearance, 'expiresAt', cur.expires_at) END,
    jsonb_build_object('clearance', p_clearance, 'expiresAt', p_expires_at));
  RETURN next_revision;
END $$;

CREATE FUNCTION public.department_remove_edge(p_department uuid, p_kind text, p_principal uuid, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.department_actor(); lk record; cur record; next_revision bigint;
BEGIN
  SELECT * INTO lk FROM public.department_lock(p_department, p_expected_revision);
  PERFORM public.department_require_owner(p_department, actor);
  SELECT e.id, e.clearance, e.expires_at INTO cur FROM public.department_edges e
   WHERE e.department_id = p_department
     AND CASE WHEN p_kind = 'user' THEN e.user_id = p_principal ELSE e.assistant_id = p_principal END
   FOR UPDATE;
  IF NOT FOUND THEN RETURN lk.revision; END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> lk.revision THEN
    RAISE EXCEPTION 'department_revision_stale';
  END IF;
  DELETE FROM public.department_edges WHERE id = cur.id;
  next_revision := public.department_bump(p_department);
  INSERT INTO public.department_audit_events(workspace_id, department_id, actor_user_id, action, principal_kind, principal_id, before_state)
  VALUES (lk.workspace_id, p_department, actor, 'edge_removed', p_kind, p_principal,
    jsonb_build_object('clearance', cur.clearance, 'expiresAt', cur.expires_at));
  RETURN next_revision;
END $$;

CREATE FUNCTION public.department_add_owner(p_department uuid, p_user uuid, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.department_actor(); lk record; next_revision bigint;
BEGIN
  SELECT * INTO lk FROM public.department_lock(p_department, p_expected_revision);
  PERFORM public.department_require_owner(p_department, actor);
  PERFORM public.department_check_principal(lk.workspace_id, 'user', p_user);
  IF EXISTS (SELECT 1 FROM public.department_owners WHERE department_id = p_department AND user_id = p_user) THEN
    RETURN lk.revision;
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> lk.revision THEN
    RAISE EXCEPTION 'department_revision_stale';
  END IF;
  INSERT INTO public.department_owners(workspace_id, department_id, user_id, added_by) VALUES (lk.workspace_id, p_department, p_user, actor);
  next_revision := public.department_bump(p_department);
  INSERT INTO public.department_audit_events(workspace_id, department_id, actor_user_id, action, principal_kind, principal_id)
  VALUES (lk.workspace_id, p_department, actor, 'owner_added', 'user', p_user);
  RETURN next_revision;
END $$;

CREATE FUNCTION public.department_remove_owner(p_department uuid, p_user uuid, p_expected_revision bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.department_actor(); lk record; next_revision bigint;
BEGIN
  SELECT * INTO lk FROM public.department_lock(p_department, p_expected_revision);
  PERFORM public.department_require_owner(p_department, actor);
  IF NOT EXISTS (SELECT 1 FROM public.department_owners WHERE department_id = p_department AND user_id = p_user) THEN
    RETURN lk.revision;
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> lk.revision THEN
    RAISE EXCEPTION 'department_revision_stale';
  END IF;
  DELETE FROM public.department_owners WHERE department_id = p_department AND user_id = p_user;
  next_revision := public.department_bump(p_department);
  INSERT INTO public.department_audit_events(workspace_id, department_id, actor_user_id, action, principal_kind, principal_id)
  VALUES (lk.workspace_id, p_department, actor, 'owner_removed', 'user', p_user);
  RETURN next_revision;
END $$;

-- The workspace owner's audited way into any department (D6b, I3). It creates
-- an owner edge and an audit event its members can see; it never reads.
CREATE FUNCTION public.department_break_glass(p_department uuid, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.department_actor(); lk record; next_revision bigint;
BEGIN
  SELECT * INTO lk FROM public.department_lock(p_department, NULL);
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members
                  WHERE workspace_id = lk.workspace_id AND user_id = actor AND role = 'owner') THEN
    RAISE EXCEPTION 'department_break_glass_owner_only';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'department_break_glass_reason_required'; END IF;
  IF EXISTS (SELECT 1 FROM public.department_owners WHERE department_id = p_department AND user_id = actor) THEN
    RETURN lk.revision;
  END IF;
  INSERT INTO public.department_audit_events(workspace_id, department_id, actor_user_id, action, principal_kind, principal_id, reason)
  VALUES (lk.workspace_id, p_department, actor, 'break_glass', 'user', actor, p_reason);
  INSERT INTO public.department_owners(workspace_id, department_id, user_id, added_by) VALUES (lk.workspace_id, p_department, actor, actor);
  next_revision := public.department_bump(p_department);
  RETURN next_revision;
END $$;

-- ── Row-level security ────────────────────────────────────────────────────
-- Writes go through the functions above only. A department's roster, owners
-- and audit trail are visible to its members (P4); the workspace owner also
-- sees owners, for the governance list.
ALTER TABLE public.department_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY department_edges_member_read ON public.department_edges FOR SELECT
  USING (public.department_clearance_in('user', nullif(current_setting('app.current_user_id', true), '')::uuid, department_id) IS NOT NULL);
CREATE POLICY department_owners_member_read ON public.department_owners FOR SELECT
  USING (public.department_clearance_in('user', nullif(current_setting('app.current_user_id', true), '')::uuid, department_id) IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = department_owners.workspace_id
                AND m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND m.role = 'owner'));
CREATE POLICY department_revisions_member_read ON public.department_revisions FOR SELECT
  USING (public.department_clearance_in('user', nullif(current_setting('app.current_user_id', true), '')::uuid, department_id) IS NOT NULL);
CREATE POLICY department_audit_member_read ON public.department_audit_events FOR SELECT
  USING (public.department_clearance_in('user', nullif(current_setting('app.current_user_id', true), '')::uuid, department_id) IS NOT NULL);

REVOKE ALL ON FUNCTION public.department_edges_reconcile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.legacy_assistant_team_compartments(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.department_lock(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.department_bump(uuid) FROM PUBLIC;

-- ── Backfill ──────────────────────────────────────────────────────────────
-- The issuer guard refuses any later change to issuer_user_id, NULL->value
-- included, so this one-time stamp of existing keys runs with it off too.
-- (Fixed 2026-10-02: the first production apply raised
-- credential_issuer_immutable on the first existing key and rolled back.)
ALTER TABLE public.brain_keys DISABLE TRIGGER external_key_admission;
ALTER TABLE public.brain_keys DISABLE TRIGGER programmatic_key_binding_version;
ALTER TABLE public.brain_keys DISABLE TRIGGER brain_keys_issuer;
ALTER TABLE public.api_keys DISABLE TRIGGER external_key_admission;
ALTER TABLE public.api_keys DISABLE TRIGGER api_keys_issuer;
UPDATE public.brain_keys SET issuer_user_id = created_by WHERE issuer_user_id IS NULL AND created_by IS NOT NULL;
UPDATE public.api_keys SET issuer_user_id = created_by WHERE issuer_user_id IS NULL AND created_by IS NOT NULL;
ALTER TABLE public.brain_keys ENABLE TRIGGER external_key_admission;
ALTER TABLE public.brain_keys ENABLE TRIGGER programmatic_key_binding_version;
ALTER TABLE public.brain_keys ENABLE TRIGGER brain_keys_issuer;
ALTER TABLE public.api_keys ENABLE TRIGGER external_key_admission;
ALTER TABLE public.api_keys ENABLE TRIGGER api_keys_issuer;

SELECT public.department_edges_reconcile(w.id) FROM public.workspaces w ORDER BY w.id;

-- Every table carries erasure capture (migration 522's canonical installer).
SELECT public.crm_install_erasure_capture();

COMMIT;
