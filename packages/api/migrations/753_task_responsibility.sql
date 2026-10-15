-- Task responsibility: typed executor, explicit human follow-up, operating home.
-- Spec: docs/architecture/features/tasks.md -> "Responsibility".
--
-- assignee_id stays the PERSON executor (a workspace_members row). A configured
-- assistant executes through executor_assistant_id; the CHECK makes the
-- executor one slot. tasks.assistant_id remains private VISIBILITY and is never
-- read as execution identity. follow_up_member_id is the optional explicit human
-- contact; it never implies execution. home_kind/home_id is the explicit
-- Department (workspace_groups) or shared Project the work belongs to.
--
-- Nothing is backfilled: existing rows keep their human assignee and an unknown
-- home. Fallback follow-up is resolved from current ownership at read time and
-- is never stored here.
BEGIN;

ALTER TABLE public.tasks
  ADD COLUMN executor_assistant_id uuid REFERENCES public.assistants(id) ON DELETE SET NULL,
  ADD COLUMN follow_up_member_id uuid REFERENCES public.workspace_members(id) ON DELETE SET NULL,
  ADD COLUMN home_kind text,
  ADD COLUMN home_id uuid,
  ADD CONSTRAINT tasks_one_executor CHECK (assignee_id IS NULL OR executor_assistant_id IS NULL),
  ADD CONSTRAINT tasks_home_shape CHECK (
    (home_kind IS NULL AND home_id IS NULL)
    OR (home_kind IN ('department', 'project') AND home_id IS NOT NULL));

-- Same-workspace integrity for every responsibility reference. SECURITY DEFINER
-- because this is integrity, not authority: the actor-bound service checks who
-- may assign; this only refuses a reference that cannot belong to the row.
CREATE FUNCTION public.tasks_responsibility_workspace_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.executor_assistant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.assistants a
     WHERE a.id = NEW.executor_assistant_id AND a.workspace_id = NEW.workspace_id AND a.kind <> 'app') THEN
    RAISE EXCEPTION 'task_executor_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.follow_up_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
     WHERE m.id = NEW.follow_up_member_id AND m.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'task_follow_up_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.home_kind = 'department' AND NOT EXISTS (
    SELECT 1 FROM public.workspace_groups g WHERE g.id = NEW.home_id AND g.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'task_home_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.home_kind = 'project' AND NOT EXISTS (
    SELECT 1 FROM public.workspace_projects p WHERE p.id = NEW.home_id AND p.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'task_home_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tasks_responsibility_workspace_match_trg
  BEFORE INSERT OR UPDATE OF executor_assistant_id, follow_up_member_id, home_kind, home_id, workspace_id
  ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.tasks_responsibility_workspace_match();

-- Eligibility helpers for the actor-bound responsibility service
-- (packages/api/src/tasks/responsibility.ts). SECURITY DEFINER because the
-- facts they read (co-member rows, other principals' edges, owner rosters) are
-- hidden from the actor by RLS; each answers one boolean or one owner set and
-- never returns row content.

-- A person may be the explicit follow-up when they can see the task: member of
-- the workspace, cleared for its sensitivity, inside its private partition,
-- inside its Team labels, and admitted to its home.
CREATE FUNCTION public.task_follow_up_eligible(
  p_workspace uuid, p_member uuid, p_sensitivity text, p_compartments text[],
  p_private_user uuid, p_home_kind text, p_home_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members m
     WHERE m.id = p_member AND m.workspace_id = p_workspace
       AND public.sensitivity_rank(p_sensitivity) <= public.sensitivity_rank(m.clearance)
       AND (p_private_user IS NULL OR p_private_user = m.user_id)
       AND (public.effective_member_team_compartments(m.user_id, p_workspace) IS NULL
         OR coalesce(p_compartments, '{}'::text[]) <@ public.effective_member_team_compartments(m.user_id, p_workspace))
       AND CASE p_home_kind
         WHEN 'department' THEN public.department_clearance_rank(public.department_clearance_in('user', m.user_id, p_home_id))
                                >= public.sensitivity_rank(p_sensitivity)
         WHEN 'project' THEN NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = p_home_id)
                             OR public.project_member_live(p_home_id, 'user', m.user_id)
         ELSE true END)
$$;

-- An assistant may execute when it is a configured (non-app) workspace
-- assistant the actor can see, not another assistant's private task, and
-- admitted to the home.
CREATE FUNCTION public.task_executor_eligible(
  p_actor uuid, p_workspace uuid, p_assistant uuid, p_private_assistant uuid,
  p_sensitivity text, p_home_kind text, p_home_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.assistants a
     WHERE a.id = p_assistant AND a.workspace_id = p_workspace AND a.kind <> 'app'
       AND public.assistant_placement_visible(p_actor, a.id)
       AND public.sensitivity_rank(p_sensitivity) <= public.sensitivity_rank(a.clearance)
       AND (p_private_assistant IS NULL OR p_private_assistant = a.id)
       AND CASE p_home_kind
         WHEN 'department' THEN public.department_clearance_in('assistant', a.id, p_home_id) IS NOT NULL
         WHEN 'project' THEN NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = p_home_id)
                             OR public.project_member_live(p_home_id, 'assistant', a.id)
         ELSE true END)
$$;

-- The actor may place work in a home they belong to: a Department where they
-- hold a live edge or ownership, or an active Project (a shared one only when
-- they are on its roster or own it).
CREATE FUNCTION public.task_home_admissible(p_actor uuid, p_workspace uuid, p_kind text, p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE p_kind
    WHEN 'department' THEN EXISTS (
      SELECT 1 FROM public.workspace_groups g WHERE g.id = p_id AND g.workspace_id = p_workspace)
      AND (public.department_clearance_in('user', p_actor, p_id) IS NOT NULL
        OR EXISTS (SELECT 1 FROM public.department_owners o WHERE o.department_id = p_id AND o.user_id = p_actor))
    WHEN 'project' THEN EXISTS (
      SELECT 1 FROM public.workspace_projects p WHERE p.id = p_id AND p.workspace_id = p_workspace AND p.status = 'active')
      AND (NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = p_id)
        OR public.project_member_live(p_id, 'user', p_actor)
        OR EXISTS (SELECT 1 FROM public.project_shared_owners o WHERE o.project_id = p_id AND o.user_id = p_actor))
    ELSE false END
$$;

-- Current eligible owners of a home: Department owners, or shared-Project
-- owners on the live roster, who are still workspace members. Resolved on
-- every read so owner changes and departures re-route attention.
CREATE FUNCTION public.task_home_owner_ids(p_workspace uuid, p_kind text, p_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT o.user_id ORDER BY o.user_id), '{}'::uuid[]) FROM (
    SELECT d.user_id FROM public.department_owners d
     WHERE p_kind = 'department' AND d.department_id = p_id AND d.workspace_id = p_workspace
    UNION ALL
    SELECT po.user_id FROM public.project_shared_owners po
     WHERE p_kind = 'project' AND po.project_id = p_id AND po.workspace_id = p_workspace
       AND public.project_member_live(p_id, 'user', po.user_id)
  ) o
  WHERE EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace AND m.user_id = o.user_id)
$$;

-- Live-row lookups for the work projection: an owner queue by home, assistant
-- work by executor, and follow-up work by contact.
CREATE INDEX idx_tasks_live_home ON public.tasks (workspace_id, home_kind, home_id)
  WHERE valid_to IS NULL AND home_id IS NOT NULL;
CREATE INDEX idx_tasks_live_executor_assistant ON public.tasks (workspace_id, executor_assistant_id)
  WHERE valid_to IS NULL AND executor_assistant_id IS NOT NULL;
CREATE INDEX idx_tasks_live_follow_up ON public.tasks (workspace_id, follow_up_member_id)
  WHERE valid_to IS NULL AND follow_up_member_id IS NOT NULL;

COMMIT;
