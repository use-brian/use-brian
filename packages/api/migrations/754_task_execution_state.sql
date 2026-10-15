-- 754_task_execution_state.sql
--
-- Resumable task execution overlay (docs/architecture/features/goals.md ->
-- "Resumable task execution"). Operational rows linked to the canonical task
-- lineage and/or a Goal: one shared allowance pool per execution tree with
-- append-only segments, per-target execution state with monotonic control and
-- checkpoint revisions, and immutable command/report receipts.
--
-- No columns are added to `tasks` (host-frozen invariant). Engine writes use
-- the owner pool; reads are source-aware through RLS: a state is visible only
-- when the viewer can see its task (every restrictive task policy applies) or,
-- for a standalone Goal, its goal row.
--
-- Numbering: the build plan provisionally allocated 3946, but the migrator
-- orders filenames lexically, so 754 is the next free name that sorts last.

BEGIN;

CREATE TABLE public.task_execution_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  root_kind text NOT NULL CHECK (root_kind IN ('task', 'goal')),
  root_id uuid NOT NULL,
  max_spend numeric(14,6) CHECK (max_spend IS NULL OR max_spend > 0),
  max_iterations integer CHECK (max_iterations IS NULL OR max_iterations > 0),
  active_segment integer NOT NULL DEFAULT 1 CHECK (active_segment >= 1),
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_execution_pools_bounded CHECK (max_spend IS NOT NULL OR max_iterations IS NOT NULL),
  CONSTRAINT task_execution_pools_id_workspace UNIQUE (id, workspace_id)
);

CREATE TABLE public.task_execution_segments (
  pool_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  segment_no integer NOT NULL CHECK (segment_no >= 1),
  opened_reason text NOT NULL CHECK (opened_reason IN ('initial', 'human_renewal')),
  opened_by_command_id uuid,
  spent numeric(14,6) NOT NULL DEFAULT 0 CHECK (spent >= 0),
  iterations integer NOT NULL DEFAULT 0 CHECK (iterations >= 0),
  reserved_spend numeric(14,6) NOT NULL DEFAULT 0 CHECK (reserved_spend >= 0),
  reserved_iterations integer NOT NULL DEFAULT 0 CHECK (reserved_iterations >= 0),
  late_spend numeric(14,6) NOT NULL DEFAULT 0 CHECK (late_spend >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  PRIMARY KEY (pool_id, segment_no),
  FOREIGN KEY (pool_id, workspace_id) REFERENCES public.task_execution_pools(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT task_execution_segments_renewal_command CHECK (opened_reason = 'initial' OR opened_by_command_id IS NOT NULL)
);

CREATE TABLE public.task_execution_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Live head of the canonical task lineage; updateTask repoints it in the
  -- supersession transaction (like goals.host_id). Not a FK: tasks are
  -- bi-temporal and the head id rotates.
  task_id uuid,
  goal_id uuid REFERENCES public.goals(id) ON DELETE CASCADE,
  parent_state_id uuid REFERENCES public.task_execution_states(id) ON DELETE CASCADE,
  child_key text,
  pool_id uuid NOT NULL,
  lane text NOT NULL CHECK (lane IN ('native', 'external')),
  executor_kind text CHECK (executor_kind IN ('assistant', 'person')),
  executor_id uuid,
  phase text NOT NULL CHECK (phase IN ('planning', 'ready', 'running', 'waiting', 'paused', 'blocked', 'done', 'retired')),
  control_revision bigint NOT NULL DEFAULT 1,
  checkpoint_revision bigint NOT NULL DEFAULT 0,
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  authoring_ref jsonb,
  blocker jsonb,
  wait jsonb,
  pause jsonb,
  in_flight jsonb,
  checkpoint jsonb,
  steering jsonb NOT NULL DEFAULT '[]'::jsonb,
  no_progress_streak integer NOT NULL DEFAULT 0 CHECK (no_progress_streak >= 0),
  transient_streak integer NOT NULL DEFAULT 0 CHECK (transient_streak >= 0),
  external_execution_id text CHECK (external_execution_id IS NULL OR length(external_execution_id) BETWEEN 1 AND 200),
  harness text CHECK (harness IS NULL OR length(harness) BETWEEN 1 AND 80),
  last_reported_at timestamptz,
  last_report_sequence bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (pool_id, workspace_id) REFERENCES public.task_execution_pools(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT task_execution_states_target CHECK (task_id IS NOT NULL OR goal_id IS NOT NULL),
  CONSTRAINT task_execution_states_external CHECK ((lane = 'external') = (external_execution_id IS NOT NULL)),
  CONSTRAINT task_execution_states_external_task CHECK (lane = 'native' OR task_id IS NOT NULL),
  CONSTRAINT task_execution_states_executor CHECK ((executor_kind IS NULL) = (executor_id IS NULL))
);

-- One active native pursuit per canonical target. Branch states (children)
-- inherit their root's task/goal unless they have their own subtask, so the
-- uniqueness applies to roots.
CREATE UNIQUE INDEX task_execution_states_active_task
  ON public.task_execution_states (task_id)
  WHERE lane = 'native' AND parent_state_id IS NULL AND task_id IS NOT NULL AND phase NOT IN ('done', 'retired');
CREATE UNIQUE INDEX task_execution_states_active_goal
  ON public.task_execution_states (goal_id)
  WHERE lane = 'native' AND parent_state_id IS NULL AND goal_id IS NOT NULL AND phase NOT IN ('done', 'retired');
-- Each bound external coding session keeps its own identity.
CREATE UNIQUE INDEX task_execution_states_external_identity
  ON public.task_execution_states (task_id, external_execution_id)
  WHERE lane = 'external';
-- Idempotent necessary-child derivation.
CREATE UNIQUE INDEX task_execution_states_child_key
  ON public.task_execution_states (parent_state_id, child_key)
  WHERE parent_state_id IS NOT NULL AND child_key IS NOT NULL;
CREATE INDEX task_execution_states_pool ON public.task_execution_states (pool_id);
CREATE INDEX task_execution_states_task ON public.task_execution_states (task_id) WHERE task_id IS NOT NULL;

CREATE TABLE public.task_execution_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  state_id uuid NOT NULL REFERENCES public.task_execution_states(id) ON DELETE CASCADE,
  pool_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('enter', 'pause', 'steer', 'continue', 'checkpoint', 'recover', 'retire', 'bind', 'report')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'assistant', 'credential', 'system')),
  actor_id text,
  origin text NOT NULL CHECK (origin IN ('ui', 'chat', 'mcp', 'worker', 'assignment')),
  human_origin boolean NOT NULL,
  expected_revision bigint,
  result_revision bigint,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'stale', 'blocked', 'duplicate')),
  renewed_segment integer,
  external_event_id text CHECK (external_event_id IS NULL OR length(external_event_id) BETWEEN 1 AND 200),
  external_sequence bigint,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (pool_id, workspace_id) REFERENCES public.task_execution_pools(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT task_execution_commands_idempotent UNIQUE (state_id, idempotency_key),
  -- Renewal is human-only, and only a user can be a human origin.
  CONSTRAINT task_execution_commands_renewal_human CHECK (renewed_segment IS NULL OR (human_origin AND outcome = 'applied')),
  CONSTRAINT task_execution_commands_human_is_user CHECK (NOT human_origin OR actor_kind = 'user')
);
CREATE UNIQUE INDEX task_execution_commands_external_event
  ON public.task_execution_commands (state_id, external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE INDEX task_execution_commands_state ON public.task_execution_commands (state_id, created_at);

-- Receipts are immutable. Deletion happens only through cascades.
CREATE FUNCTION public.task_execution_commands_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'task_execution_command_immutable' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER task_execution_commands_immutable_trg
  BEFORE UPDATE ON public.task_execution_commands
  FOR EACH ROW EXECUTE FUNCTION public.task_execution_commands_immutable();

-- Revisions only move forward; the pool and parent stay in-workspace.
CREATE FUNCTION public.task_execution_states_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.control_revision < OLD.control_revision OR NEW.checkpoint_revision < OLD.checkpoint_revision THEN
      RAISE EXCEPTION 'task_execution_revision_regressed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id OR NEW.pool_id <> OLD.pool_id OR NEW.lane <> OLD.lane THEN
      RAISE EXCEPTION 'task_execution_identity_immutable' USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
  END IF;
  IF NEW.parent_state_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.task_execution_states p
     WHERE p.id = NEW.parent_state_id AND p.workspace_id = NEW.workspace_id AND p.pool_id = NEW.pool_id
  ) THEN
    RAISE EXCEPTION 'task_execution_parent_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_execution_states_guard_trg
  BEFORE INSERT OR UPDATE ON public.task_execution_states
  FOR EACH ROW EXECUTE FUNCTION public.task_execution_states_guard();

CREATE FUNCTION public.task_execution_pools_touch() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.root_kind <> OLD.root_kind OR NEW.root_id <> OLD.root_id THEN
    RAISE EXCEPTION 'task_execution_identity_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.active_segment < OLD.active_segment OR NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'task_execution_revision_regressed' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER task_execution_pools_touch_trg
  BEFORE UPDATE ON public.task_execution_pools
  FOR EACH ROW EXECUTE FUNCTION public.task_execution_pools_touch();


-- Lineage writes reachable from the RLS-enforced task writer. They change only
-- what the verified lineage fact allows: a repoint requires that `from_task`
-- was superseded by `to_task`; a retirement requires that the task left the
-- live set (deleted) or that its live executor no longer matches the state's.
CREATE FUNCTION public.task_execution_repoint(from_task uuid, to_task uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tasks WHERE id = from_task AND superseded_by = to_task) THEN
    RETURN 0;
  END IF;
  UPDATE task_execution_states SET task_id = to_task WHERE task_id = from_task;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION public.task_execution_retire(target_task uuid, reason text)
  RETURNS TABLE (state_id uuid, goal_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF reason = 'host_task_deleted' THEN
    IF EXISTS (SELECT 1 FROM tasks t WHERE t.id = target_task AND t.valid_to IS NULL AND t.retracted_at IS NULL) THEN
      RETURN;
    END IF;
  ELSIF reason = 'executor_changed' THEN
    NULL; -- filtered per state below against the live executor
  ELSE
    RAISE EXCEPTION 'task_execution_retire_reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  WITH retired AS (
    UPDATE task_execution_states s SET phase = 'retired', blocker = jsonb_build_object('reason', reason)
     WHERE s.task_id = target_task AND s.lane = 'native' AND s.phase NOT IN ('done', 'retired')
       AND (reason = 'host_task_deleted' OR NOT EXISTS (
             SELECT 1 FROM tasks t WHERE t.id = target_task AND t.valid_to IS NULL
                AND ((s.executor_kind = 'assistant' AND t.executor_assistant_id = s.executor_id)
                  OR (s.executor_kind = 'person' AND t.assignee_id = s.executor_id))))
     RETURNING s.id, s.workspace_id, s.pool_id, s.goal_id, s.control_revision),
  receipts AS (
    INSERT INTO task_execution_commands (workspace_id, state_id, pool_id, idempotency_key, kind, actor_kind, origin,
                                         human_origin, result_revision, outcome, payload)
    SELECT r.workspace_id, r.id, r.pool_id, 'retire:' || reason || ':' || gen_random_uuid(), 'retire', 'system', 'worker',
           false, r.control_revision, 'applied', jsonb_build_object('reason', reason)
      FROM retired r)
  SELECT r.id, r.goal_id FROM retired r;
END $$;

-- Source-aware read policies. The EXISTS subqueries run under the viewer's own
-- policies on tasks/goals, so every restrictive task predicate (department,
-- sensitivity, private partition, Project scope) applies here too.
ALTER TABLE public.task_execution_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_execution_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_execution_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_execution_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_execution_states_read ON public.task_execution_states FOR SELECT USING (
  workspace_id IN (SELECT m.workspace_id FROM public.workspace_members m
                    WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  AND CASE WHEN task_id IS NOT NULL
           THEN EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_execution_states.task_id)
           ELSE EXISTS (SELECT 1 FROM public.goals g WHERE g.id = task_execution_states.goal_id) END
);
CREATE POLICY task_execution_pools_read ON public.task_execution_pools FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.task_execution_states s WHERE s.pool_id = task_execution_pools.id)
);
CREATE POLICY task_execution_segments_read ON public.task_execution_segments FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.task_execution_states s WHERE s.pool_id = task_execution_segments.pool_id)
);
CREATE POLICY task_execution_commands_read ON public.task_execution_commands FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.task_execution_states s WHERE s.id = task_execution_commands.state_id)
);

COMMIT;
