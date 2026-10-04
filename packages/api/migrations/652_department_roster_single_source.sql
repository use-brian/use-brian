BEGIN;

-- One department roster (permission model v2, D26; platform
-- docs/plans/permission-model-v2.md). Organization -> Departments edits the
-- department edges directly, while the reconcile of 651 still derives `member`
-- edges from Team membership and `assistant` edges from Team assistant
-- assignments. Without this migration the two disagree: removing a person in
-- the panel deletes the edge, leaves the membership, and the next reconcile
-- puts the edge back. From here on the edge and its legacy source move
-- together, whichever side is written.
-- Spec: docs/architecture/features/workspace-access.md -> "One roster".

-- Adding someone in the panel also makes them a Team member (or assigns the
-- assistant), so every surface that lists Team membership agrees. The edge is
-- written first with origin `store`; the membership insert re-runs the
-- reconcile, which never overwrites a `store` edge, so the chosen clearance
-- and expiry stand.
CREATE OR REPLACE FUNCTION public.department_set_edge(p_department uuid, p_kind text, p_principal uuid, p_clearance text,
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
    INSERT INTO public.workspace_group_members(group_id, user_id) VALUES (p_department, p_principal)
    ON CONFLICT (group_id, user_id) DO NOTHING;
  ELSE
    INSERT INTO public.department_edges(workspace_id, department_id, principal_kind, assistant_id, clearance, expires_at, origin, added_by)
    VALUES (lk.workspace_id, p_department, 'assistant', p_principal, p_clearance, p_expires_at, 'store', actor)
    ON CONFLICT (department_id, assistant_id) WHERE assistant_id IS NOT NULL
    DO UPDATE SET clearance = EXCLUDED.clearance, expires_at = EXCLUDED.expires_at, origin = 'store', added_by = EXCLUDED.added_by;
    INSERT INTO public.workspace_group_assistants(group_id, assistant_id, added_by_user_id) VALUES (p_department, p_principal, actor)
    ON CONFLICT (group_id, assistant_id) DO NOTHING;
  END IF;
  next_revision := public.department_bump(p_department);
  INSERT INTO public.department_audit_events(workspace_id, department_id, actor_user_id, action, principal_kind, principal_id, before_state, after_state)
  VALUES (lk.workspace_id, p_department, actor, 'edge_set', p_kind, p_principal,
    CASE WHEN cur IS NULL THEN NULL ELSE jsonb_build_object('clearance', cur.clearance, 'expiresAt', cur.expires_at) END,
    jsonb_build_object('clearance', p_clearance, 'expiresAt', p_expires_at));
  RETURN next_revision;
END $$;

-- Removing someone in the panel also ends the Team membership (or assistant
-- assignment) that would re-derive the edge. Two sources the panel cannot end
-- are refused by name instead of silently coming back: the primary assistant,
-- which reads every department by design (D12), and a live approved access
-- grant, which is revoked from the access requests view where it was approved.
CREATE OR REPLACE FUNCTION public.department_remove_edge(p_department uuid, p_kind text, p_principal uuid, p_expected_revision bigint)
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
  IF p_kind = 'assistant' AND EXISTS (SELECT 1 FROM public.assistants WHERE id = p_principal AND kind = 'primary') THEN
    RAISE EXCEPTION 'department_primary_assistant';
  END IF;
  IF p_kind = 'user' AND EXISTS (
       SELECT 1 FROM public.workspace_access_grants gr
        WHERE gr.workspace_id = lk.workspace_id AND gr.target_team_id = p_department AND gr.revoked_at IS NULL
          AND gr.starts_at <= now() AND (gr.expires_at IS NULL OR gr.expires_at > now())
          AND ((gr.beneficiary_kind = 'member' AND gr.beneficiary_id = p_principal)
            OR (gr.beneficiary_kind = 'team' AND EXISTS (SELECT 1 FROM public.workspace_group_members gm
                                                          WHERE gm.group_id = gr.beneficiary_id AND gm.user_id = p_principal)))) THEN
    RAISE EXCEPTION 'department_access_via_grant';
  END IF;
  DELETE FROM public.department_edges WHERE id = cur.id;
  IF p_kind = 'user' THEN
    DELETE FROM public.workspace_group_members WHERE group_id = p_department AND user_id = p_principal;
  ELSE
    DELETE FROM public.workspace_group_assistants WHERE group_id = p_department AND assistant_id = p_principal;
  END IF;
  next_revision := public.department_bump(p_department);
  INSERT INTO public.department_audit_events(workspace_id, department_id, actor_user_id, action, principal_kind, principal_id, before_state)
  VALUES (lk.workspace_id, p_department, actor, 'edge_removed', p_kind, p_principal,
    jsonb_build_object('clearance', cur.clearance, 'expiresAt', cur.expires_at));
  RETURN next_revision;
END $$;

-- The other direction: ending a Team membership or assistant assignment on
-- any other surface (Brian's workspace-access commands, the API) ends the
-- department edge too, whatever its origin. An owner keeps their edge (the
-- owner guard requires it); the primary assistant keeps its edge (D12).
CREATE FUNCTION public.department_membership_ended() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'workspace_group_members' THEN
    DELETE FROM public.department_edges e
     WHERE e.department_id = OLD.group_id AND e.user_id = OLD.user_id
       AND NOT EXISTS (SELECT 1 FROM public.department_owners o
                        WHERE o.department_id = e.department_id AND o.user_id = e.user_id);
  ELSE
    DELETE FROM public.department_edges e
     WHERE e.department_id = OLD.group_id AND e.assistant_id = OLD.assistant_id
       AND NOT EXISTS (SELECT 1 FROM public.assistants a WHERE a.id = OLD.assistant_id AND a.kind = 'primary');
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.department_membership_ended() FROM PUBLIC;
CREATE TRIGGER department_membership_ended AFTER DELETE ON public.workspace_group_members
  FOR EACH ROW EXECUTE FUNCTION public.department_membership_ended();
CREATE TRIGGER department_membership_ended AFTER DELETE ON public.workspace_group_assistants
  FOR EACH ROW EXECUTE FUNCTION public.department_membership_ended();

-- Team-to-Team read bundles and "read every Team" no longer create access
-- after the cutover (D23); their controls are retired from every surface and
-- the command is refused by the API. Existing rows stay as inert history.

-- Panel-written edges whose source a pre-652 removal left behind: a `store`
-- edge with no membership gets its membership back, so the two sides start
-- aligned.
INSERT INTO public.workspace_group_members(group_id, user_id)
SELECT e.department_id, e.user_id FROM public.department_edges e
 WHERE e.origin = 'store' AND e.user_id IS NOT NULL
ON CONFLICT (group_id, user_id) DO NOTHING;
INSERT INTO public.workspace_group_assistants(group_id, assistant_id, added_by_user_id)
SELECT e.department_id, e.assistant_id, e.added_by FROM public.department_edges e
 WHERE e.origin = 'store' AND e.assistant_id IS NOT NULL
ON CONFLICT (group_id, assistant_id) DO NOTHING;

COMMIT;
