BEGIN;

-- Permission model v2: post-cutover edges (D23), home departments (D24) and
-- the department directory (D25). Platform docs/plans/permission-model-v2.md;
-- spec: docs/architecture/features/workspace-access.md -> "Department
-- management and home departments (v2, migration 651)".

-- ── D23: a role or a legacy universe never re-derives an edge ─────────────
-- Edges the cutover derived from universe reach become `migrated`, so the v2
-- reconcile below keeps them (owners review and remove them) instead of
-- deleting them on the first sync.
UPDATE public.department_edges e SET origin = 'migrated'
 WHERE e.origin = 'assistant'
   AND NOT EXISTS (SELECT 1 FROM public.workspace_group_assistants ga
                    WHERE ga.group_id = e.department_id AND ga.assistant_id = e.assistant_id);

CREATE OR REPLACE FUNCTION public.department_edges_reconcile(p_workspace uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v2 boolean;
BEGIN
  SELECT coalesce((to_jsonb(w) ->> 'department_read_v2')::boolean, false) INTO v2 FROM public.workspaces w WHERE w.id = p_workspace;

  INSERT INTO public.department_revisions(department_id, workspace_id)
  SELECT g.id, g.workspace_id FROM public.workspace_groups g
   WHERE g.workspace_id = p_workspace AND g.kind = 'team'
  ON CONFLICT (department_id) DO NOTHING;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.derived_edges (
    department_id uuid, principal_kind text, principal uuid, clearance text, expires_at timestamptz, origin text
  ) ON COMMIT DROP;
  DELETE FROM pg_temp.derived_edges;

  IF v2 THEN
    -- Real sources only: Team memberships at the member's clearance.
    INSERT INTO pg_temp.derived_edges
    SELECT g.id, 'user', gm.user_id, m.clearance, NULL, 'member'
      FROM public.workspace_group_members gm
      JOIN public.workspace_groups g ON g.id = gm.group_id AND g.kind = 'team' AND g.workspace_id = p_workspace
      JOIN public.workspace_members m ON m.workspace_id = p_workspace AND m.user_id = gm.user_id;
  ELSE
    -- Legacy (pre-flip): exactly the Teams legacy resolution reaches.
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
  END IF;

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

  -- Assistants: the primary joins every department at confidential (D12);
  -- others get their explicit Team assignments (v2) or legacy reach (pre-flip),
  -- where reach without an explicit assignment is `migrated`.
  INSERT INTO pg_temp.derived_edges
  SELECT g.id, 'assistant', a.id,
         CASE WHEN a.kind = 'primary' THEN 'confidential' ELSE a.clearance END,
         NULL,
         CASE WHEN a.kind = 'primary' THEN 'primary'
              WHEN EXISTS (SELECT 1 FROM public.workspace_group_assistants ga WHERE ga.group_id = g.id AND ga.assistant_id = a.id) THEN 'assistant'
              ELSE 'migrated' END
    FROM public.assistants a
    CROSS JOIN LATERAL (SELECT CASE WHEN a.kind = 'primary' THEN NULL
                                    ELSE public.legacy_assistant_team_compartments(a.id) END AS reach) r
    JOIN public.workspace_groups g ON g.workspace_id = a.workspace_id AND g.kind = 'team'
   WHERE a.workspace_id = p_workspace
     AND (r.reach IS NULL OR g.compartment_key = ANY(r.reach))
     AND (NOT v2 OR a.kind = 'primary'
          OR EXISTS (SELECT 1 FROM public.workspace_group_assistants ga WHERE ga.group_id = g.id AND ga.assistant_id = a.id));

  -- Drop derived edges whose source is gone. After the flip `migrated` edges
  -- have no live source by definition and are kept for owner review.
  DELETE FROM public.department_edges e
   WHERE e.workspace_id = p_workspace
     AND (e.origin IN ('member','grant','assistant','primary') OR (e.origin = 'migrated' AND NOT v2))
     AND NOT EXISTS (SELECT 1 FROM pg_temp.derived_edges d
                     WHERE d.department_id = e.department_id
                       AND d.principal = coalesce(e.user_id, e.assistant_id))
     AND NOT EXISTS (SELECT 1 FROM public.department_owners o
                      WHERE o.department_id = e.department_id AND o.user_id = e.user_id);

  INSERT INTO public.department_edges(workspace_id, department_id, principal_kind, user_id, clearance, expires_at, origin)
  SELECT p_workspace, d.department_id, 'user', d.principal, d.clearance, d.expires_at, d.origin
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
   WHERE department_edges.origin IN ('assistant','primary','migrated');

  -- Owners: every live Team manager, else the creating member, else the
  -- workspace owner (pre-flip only: after the flip a department without an
  -- owner is recovered by break-glass, never by a role).
  INSERT INTO public.department_owners(workspace_id, department_id, user_id)
  SELECT tm.workspace_id, tm.team_id, tm.user_id FROM public.workspace_team_managers tm
    JOIN public.workspace_members m ON m.workspace_id = tm.workspace_id AND m.user_id = tm.user_id
   WHERE tm.workspace_id = p_workspace AND tm.revoked_at IS NULL
  ON CONFLICT DO NOTHING;
  IF NOT v2 THEN
    INSERT INTO public.department_owners(workspace_id, department_id, user_id)
    SELECT g.workspace_id, g.id, o.user_id
      FROM public.workspace_groups g
      CROSS JOIN LATERAL (
        SELECT coalesce((SELECT m.user_id FROM public.workspace_members m
                          WHERE m.workspace_id = g.workspace_id AND m.user_id = g.created_by),
                        (SELECT m.user_id FROM public.workspace_members m
                          WHERE m.workspace_id = g.workspace_id AND m.role = 'owner' ORDER BY m.joined_at, m.user_id LIMIT 1)) AS user_id) o
     WHERE g.workspace_id = p_workspace AND g.kind = 'team' AND o.user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.department_owners x WHERE x.department_id = g.id)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- ── D24: home departments ─────────────────────────────────────────────────
ALTER TABLE public.workspace_members ADD COLUMN home_department_id uuid;
ALTER TABLE public.workspace_members ADD CONSTRAINT workspace_members_home_department_fkey
  FOREIGN KEY (workspace_id, home_department_id) REFERENCES public.workspace_groups(workspace_id, id) ON DELETE SET NULL (home_department_id);
ALTER TABLE public.assistants ADD COLUMN home_department_id uuid;
ALTER TABLE public.assistants ADD CONSTRAINT assistants_home_department_fkey
  FOREIGN KEY (workspace_id, home_department_id) REFERENCES public.workspace_groups(workspace_id, id) ON DELETE SET NULL (home_department_id);

ALTER TABLE public.department_audit_events DROP CONSTRAINT department_audit_events_action_check;
ALTER TABLE public.department_audit_events ADD CONSTRAINT department_audit_events_action_check
  CHECK (action IN ('edge_set','edge_removed','owner_added','owner_removed','break_glass','home_set'));

-- Set or clear (p_department NULL) a home. The principal must hold an
-- unexpired edge there. A person sets their own; a workspace owner or admin
-- sets anyone's; an assistant's owner sets that assistant's.
CREATE FUNCTION public.department_set_home(p_workspace uuid, p_kind text, p_principal uuid, p_department uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.department_actor(); governance boolean;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id = p_workspace FOR UPDATE;
  SELECT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = p_workspace AND user_id = actor AND role IN ('owner','admin'))
    INTO governance;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = p_workspace AND user_id = actor) THEN
    RAISE EXCEPTION 'department_owner_required';
  END IF;
  IF p_kind = 'user' THEN
    IF p_principal <> actor AND NOT governance THEN RAISE EXCEPTION 'department_home_not_allowed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = p_workspace AND user_id = p_principal) THEN
      RAISE EXCEPTION 'department_principal_not_in_workspace';
    END IF;
  ELSIF p_kind = 'assistant' THEN
    IF NOT EXISTS (SELECT 1 FROM public.assistants WHERE id = p_principal AND workspace_id = p_workspace) THEN
      RAISE EXCEPTION 'department_principal_not_in_workspace';
    END IF;
    IF NOT governance AND NOT EXISTS (SELECT 1 FROM public.assistants a WHERE a.id = p_principal AND a.owner_user_id = actor)
       AND NOT EXISTS (SELECT 1 FROM public.assistant_members am WHERE am.assistant_id = p_principal AND am.user_id = actor AND am.role = 'owner') THEN
      RAISE EXCEPTION 'department_home_not_allowed';
    END IF;
  ELSE
    RAISE EXCEPTION 'department_principal_invalid';
  END IF;
  IF p_department IS NOT NULL AND public.department_clearance_in(p_kind, p_principal, p_department) IS NULL THEN
    RAISE EXCEPTION 'department_home_requires_edge';
  END IF;
  IF p_kind = 'user' THEN
    UPDATE public.workspace_members SET home_department_id = p_department WHERE workspace_id = p_workspace AND user_id = p_principal;
  ELSE
    UPDATE public.assistants SET home_department_id = p_department WHERE id = p_principal;
  END IF;
  IF p_department IS NOT NULL THEN
    INSERT INTO public.department_audit_events(workspace_id, department_id, actor_user_id, action, principal_kind, principal_id)
    VALUES (p_workspace, p_department, actor, 'home_set', p_kind, p_principal);
  END IF;
END $$;

-- Losing the edge loses the home.
CREATE FUNCTION public.clear_department_home() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.expires_at IS NULL THEN RETURN NULL; END IF;
  IF OLD.user_id IS NOT NULL THEN
    UPDATE public.workspace_members SET home_department_id = NULL
     WHERE workspace_id = OLD.workspace_id AND user_id = OLD.user_id AND home_department_id = OLD.department_id
       AND (TG_OP = 'DELETE' OR NEW.expires_at <= clock_timestamp());
  ELSE
    UPDATE public.assistants SET home_department_id = NULL
     WHERE id = OLD.assistant_id AND home_department_id = OLD.department_id
       AND (TG_OP = 'DELETE' OR NEW.expires_at <= clock_timestamp());
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER department_edges_clear_home AFTER DELETE OR UPDATE OF expires_at ON public.department_edges
  FOR EACH ROW EXECUTE FUNCTION public.clear_department_home();

-- The stamp. A v2 workspace's new content row with no department label lands
-- in the writer's home department (assistant first, else human). Only an
-- explicit General choice by a person (admission sets app.explicit_general
-- for that write) keeps General. Never removes a label (I13). Runs before the
-- creation-admission check (zzzz_*), which sees the stamped envelope.
CREATE FUNCTION public.stamp_department_home() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb := to_jsonb(NEW); home uuid; who_a uuid; who_u uuid;
BEGIN
  IF current_setting('app.explicit_general', true) = 'true' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(NEW.compartments, '{}'::text[])) k WHERE k LIKE 'team:%') THEN RETURN NEW; END IF;
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
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['memories','entities','entity_links','episodes','tasks','workspace_files'] LOOP
    EXECUTE format('CREATE TRIGGER zzz_department_home_stamp BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stamp_department_home()', tab);
  END LOOP;
END $$;

-- ── D25: the department directory ─────────────────────────────────────────
-- Members see their departments with their own clearance and home; the
-- workspace owner additionally sees every department's name and owners (P4,
-- I2). Nothing else about a department leaks to a non-member.
CREATE FUNCTION public.department_directory(p_workspace uuid)
RETURNS TABLE (department_id uuid, name text, status text, revision bigint, my_clearance text, is_owner boolean, owner_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH actor AS (SELECT nullif(current_setting('app.current_user_id', true), '')::uuid AS u),
       ws_owner AS (SELECT EXISTS (SELECT 1 FROM public.workspace_members m, actor
                                    WHERE m.workspace_id = p_workspace AND m.user_id = actor.u AND m.role = 'owner') AS yes)
  SELECT g.id, g.name, g.status, coalesce(r.revision, 1),
         public.department_clearance_in('user', actor.u, g.id),
         EXISTS (SELECT 1 FROM public.department_owners o WHERE o.department_id = g.id AND o.user_id = actor.u),
         ARRAY(SELECT o.user_id FROM public.department_owners o WHERE o.department_id = g.id ORDER BY o.user_id)
    FROM public.workspace_groups g
    CROSS JOIN actor CROSS JOIN ws_owner
    LEFT JOIN public.department_revisions r ON r.department_id = g.id
   WHERE g.workspace_id = p_workspace AND g.kind = 'team'
     AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace AND m.user_id = actor.u)
     AND (public.department_clearance_in('user', actor.u, g.id) IS NOT NULL OR ws_owner.yes)
   ORDER BY g.name, g.id
$$;

COMMIT;
