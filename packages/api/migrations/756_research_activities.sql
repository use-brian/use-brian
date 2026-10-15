-- 756_research_activities.sql
--
-- Saved research, scoped feedback learning and engine improvement
-- (docs/architecture/features/research.md). A research activity is a
-- result/evidence manifest over the existing coordinator/workers, canonical
-- writers and playbook - not another execution engine or prompt-rule store.
--
--   research_activities         one row per actual research invocation
--   research_artifact_links     inspected canonical write receipts
--   research_feedback           a direct member follow-up linked to an output
--   research_feedback_revisions append-only interpretation/correction history
--   research_improvements       generic improvement candidates
--   research_comparisons        immutable engine comparison records
--
-- assistant_playbook_rules gains research applicability and server-owned
-- research scope instead of a second rule table.
--
-- Writes go through the owner pool inside service transactions; every read is
-- source-aware through RLS. An activity is visible through its originating
-- session's own policies (native audience), or through a live shared-Project
-- membership plus a readable output artifact. Feedback additionally requires
-- its source message to be readable now (holds and deletes apply).
--
-- Numbering: the build plan provisionally reserved 3946, but the migrator
-- orders filenames lexically, so 756 is the next free name that sorts last
-- (the same reason 754 did not use 3946).

BEGIN;

CREATE TABLE public.research_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  request_message_id uuid REFERENCES public.session_messages(id) ON DELETE SET NULL,
  request_message_version bigint,
  output_message_id uuid REFERENCES public.session_messages(id) ON DELETE SET NULL,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES public.assistants(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.workspace_projects(id) ON DELETE SET NULL,
  -- Native execution id when the research runs inside a tracked Task. Not a
  -- FK: tasks are bi-temporal and the head id rotates.
  task_id uuid,
  predecessor_activity_id uuid REFERENCES public.research_activities(id) ON DELETE SET NULL,
  entry text NOT NULL CHECK (entry IN ('explicit', 'adaptive')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'saved', 'partial', 'failed')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  planned_page_id uuid,
  runtime jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(runtime) = 'object'),
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 50),
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array' AND jsonb_array_length(gaps) <= 20),
  findings_count integer NOT NULL DEFAULT 0 CHECK (findings_count >= 0),
  summary text CHECK (summary IS NULL OR length(summary) <= 1000),
  save_error text CHECK (save_error IS NULL OR length(save_error) <= 200),
  sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'confidential')),
  compartments text[] NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT research_activities_idempotent UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT research_activities_id_workspace UNIQUE (id, workspace_id),
  CONSTRAINT research_activities_settled CHECK ((status = 'running') = (completed_at IS NULL))
);
CREATE INDEX research_activities_session ON public.research_activities (session_id, created_at DESC);
CREATE INDEX research_activities_workspace ON public.research_activities (workspace_id, created_at DESC);
CREATE INDEX research_activities_project ON public.research_activities (project_id, created_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX research_activities_output_message ON public.research_activities (output_message_id) WHERE output_message_id IS NOT NULL;

CREATE TABLE public.research_artifact_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('page', 'document', 'file')),
  artifact_id uuid NOT NULL,
  version integer CHECK (version IS NULL OR version >= 0),
  relation text NOT NULL CHECK (relation IN ('output', 'revision')),
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  tool_use_id text NOT NULL CHECK (length(tool_use_id) BETWEEN 1 AND 256),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (activity_id, workspace_id) REFERENCES public.research_activities(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX research_artifact_links_unique
  ON public.research_artifact_links (activity_id, kind, artifact_id, coalesce(version, -1));
CREATE INDEX research_artifact_links_artifact ON public.research_artifact_links (kind, artifact_id);

CREATE TABLE public.research_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  -- The canonical member message. Deleting it (retry/edit truncation, session
  -- delete, erasure) deletes the follow-up: support never outlives its source.
  message_id uuid NOT NULL REFERENCES public.session_messages(id) ON DELETE CASCADE,
  message_version bigint NOT NULL CHECK (message_version > 0),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  output_key text NOT NULL CHECK (length(output_key) BETWEEN 1 AND 200),
  association text NOT NULL CHECK (association IN ('explicit_selection', 'explicit_reply', 'same_chat_continuation')),
  decision_event_id uuid REFERENCES public.decision_events(id) ON DELETE SET NULL,
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'confidential')),
  compartments text[] NOT NULL DEFAULT '{}',
  project_id uuid REFERENCES public.workspace_projects(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (activity_id, workspace_id) REFERENCES public.research_activities(id, workspace_id) ON DELETE CASCADE,
  -- One follow-up per canonical message: a replayed capture converges.
  CONSTRAINT research_feedback_message UNIQUE (message_id),
  CONSTRAINT research_feedback_id_workspace UNIQUE (id, workspace_id)
);
CREATE INDEX research_feedback_activity ON public.research_feedback (activity_id, created_at);
CREATE INDEX research_feedback_actor ON public.research_feedback (workspace_id, actor_user_id, created_at DESC);

CREATE TABLE public.research_feedback_revisions (
  feedback_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  kind text NOT NULL CHECK (kind IN ('correction', 'request_correction', 'missing_coverage', 'preference',
    'deeper_exploration', 'changed_objective', 'satisfaction', 'uncertain')),
  uncertain boolean NOT NULL,
  origin text NOT NULL CHECK (origin IN ('machine', 'human')),
  stance text NOT NULL DEFAULT 'interpretation' CHECK (stance IN ('interpretation', 'disagreement')),
  interpreter text CHECK (interpreter IS NULL OR length(interpreter) <= 64),
  actor_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  note text CHECK (note IS NULL OR length(note) <= 1000),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feedback_id, revision),
  FOREIGN KEY (feedback_id, workspace_id) REFERENCES public.research_feedback(id, workspace_id) ON DELETE CASCADE,
  -- Machine interpretations have no actor; a human revision always does.
  CONSTRAINT research_feedback_revisions_origin CHECK ((origin = 'human') = (actor_user_id IS NOT NULL)),
  CONSTRAINT research_feedback_revisions_machine CHECK (origin = 'human' OR (stance = 'interpretation' AND interpreter IS NOT NULL))
);
CREATE UNIQUE INDEX research_feedback_revisions_idempotent
  ON public.research_feedback_revisions (feedback_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.research_improvements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  pattern text NOT NULL CHECK (length(pattern) BETWEEN 3 AND 2000),
  desired_behavior text NOT NULL CHECK (length(desired_behavior) BETWEEN 3 AND 2000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'evaluating', 'checked', 'deferred')),
  task_id uuid,
  feedback_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(feedback_ids) <= 50),
  activity_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(activity_ids) <= 50),
  sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'confidential')),
  compartments text[] NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_improvements_idempotent UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT research_improvements_id_workspace UNIQUE (id, workspace_id)
);
CREATE INDEX research_improvements_workspace ON public.research_improvements (workspace_id, created_at DESC);

CREATE TABLE public.research_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  improvement_id uuid NOT NULL,
  recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  verification text NOT NULL CHECK (verification IN ('local_verified', 'externally_reported')),
  case_set_version text NOT NULL CHECK (length(case_set_version) BETWEEN 1 AND 100),
  dataset_version text NOT NULL CHECK (length(dataset_version) BETWEEN 1 AND 100),
  judge_identity text NOT NULL CHECK (length(judge_identity) BETWEEN 1 AND 200),
  baseline_identity jsonb NOT NULL CHECK (jsonb_typeof(baseline_identity) = 'object'),
  candidate_identity jsonb NOT NULL CHECK (jsonb_typeof(candidate_identity) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  trace_manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trace_manifest) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (improvement_id, workspace_id) REFERENCES public.research_improvements(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT research_comparisons_idempotent UNIQUE (improvement_id, idempotency_key)
);

-- ── Immutability ───────────────────────────────────────────────────────────

CREATE FUNCTION public.research_reject_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER research_feedback_revisions_immutable BEFORE UPDATE ON public.research_feedback_revisions
  FOR EACH ROW EXECUTE FUNCTION public.research_reject_update();
CREATE TRIGGER research_comparisons_immutable BEFORE UPDATE ON public.research_comparisons
  FOR EACH ROW EXECUTE FUNCTION public.research_reject_update();
CREATE TRIGGER research_artifact_links_immutable BEFORE UPDATE ON public.research_artifact_links
  FOR EACH ROW EXECUTE FUNCTION public.research_reject_update();

-- A deleted page or Office artifact drops its links; the activity keeps its
-- history and the link view simply loses the artifact.
CREATE FUNCTION public.research_drop_artifact_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.research_artifact_links WHERE kind = TG_ARGV[0] AND artifact_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER research_page_links_drop AFTER DELETE ON public.saved_views
  FOR EACH ROW EXECUTE FUNCTION public.research_drop_artifact_links('page');
CREATE TRIGGER research_document_links_drop AFTER DELETE ON public.office_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.research_drop_artifact_links('document');

-- ── Visibility ─────────────────────────────────────────────────────────────

-- Project leg helper. SECURITY DEFINER only to read the links table without
-- re-entering the activity policy; the page check itself is the viewer's own
-- current page boundary (saved_view_root_operation_scope_allows).
CREATE FUNCTION public.research_activity_has_readable_page(p_activity uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.research_artifact_links l
    WHERE l.activity_id = p_activity AND l.kind = 'page'
      AND public.saved_view_root_operation_scope_allows(l.artifact_id, false))
$$;

ALTER TABLE public.research_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_artifact_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_feedback_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_improvements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_comparisons ENABLE ROW LEVEL SECURITY;

CREATE POLICY research_activities_read ON public.research_activities FOR SELECT USING (
  workspace_id IN (SELECT m.workspace_id FROM public.workspace_members m
                    WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  AND (
    EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = research_activities.session_id)
    OR (project_id IS NOT NULL
        AND public.project_member_live(project_id, 'user', nullif(current_setting('app.current_user_id', true), '')::uuid)
        AND public.research_activity_has_readable_page(id))
  ));
CREATE POLICY research_activities_floor ON public.research_activities AS RESTRICTIVE FOR SELECT USING (
  public.department_row_allows((SELECT public.department_read_grants()), workspace_id, sensitivity, compartments, NULL));

CREATE POLICY research_artifact_links_read ON public.research_artifact_links FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.research_activities a WHERE a.id = research_artifact_links.activity_id)
  AND CASE kind
        WHEN 'page' THEN public.saved_view_root_operation_scope_allows(artifact_id, false)
        WHEN 'file' THEN EXISTS (SELECT 1 FROM public.workspace_files f WHERE f.id = research_artifact_links.artifact_id)
        ELSE EXISTS (SELECT 1 FROM public.office_artifacts o WHERE o.id = research_artifact_links.artifact_id)
      END);

CREATE POLICY research_feedback_read ON public.research_feedback FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.research_activities a WHERE a.id = research_feedback.activity_id)
  AND EXISTS (SELECT 1 FROM public.session_messages m WHERE m.id = research_feedback.message_id));
CREATE POLICY research_feedback_floor ON public.research_feedback AS RESTRICTIVE FOR SELECT USING (
  public.department_row_allows((SELECT public.department_read_grants()), workspace_id, sensitivity, compartments, NULL));

CREATE POLICY research_feedback_revisions_read ON public.research_feedback_revisions FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.research_feedback f WHERE f.id = research_feedback_revisions.feedback_id));

-- Improvement candidates may cite private evidence: the nominating member and
-- workspace owners/admins see the candidate; its evidence references are
-- re-resolved under each viewer's own access on read.
CREATE POLICY research_improvements_read ON public.research_improvements FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.workspace_members m
           WHERE m.workspace_id = research_improvements.workspace_id
             AND m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
             AND (m.role IN ('owner', 'admin') OR m.user_id = research_improvements.created_by)));
CREATE POLICY research_improvements_floor ON public.research_improvements AS RESTRICTIVE FOR SELECT USING (
  public.department_row_allows((SELECT public.department_read_grants()), workspace_id, sensitivity, compartments, NULL));

CREATE POLICY research_comparisons_read ON public.research_comparisons FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.research_improvements i WHERE i.id = research_comparisons.improvement_id));

-- ── Playbook: research applicability and scope ─────────────────────────────

ALTER TABLE public.assistant_playbook_rules DROP CONSTRAINT assistant_playbook_rules_applicability_kind_check;
ALTER TABLE public.assistant_playbook_rules ADD CONSTRAINT assistant_playbook_rules_applicability_kind_check
  CHECK (applicability_kind IN ('general', 'email', 'tool', 'feed', 'research'));
ALTER TABLE public.assistant_playbook_rules DROP CONSTRAINT assistant_playbook_rules_created_by_check;
ALTER TABLE public.assistant_playbook_rules ADD CONSTRAINT assistant_playbook_rules_created_by_check
  CHECK (created_by IN ('reflection', 'owner', 'decision_reflection', 'research_reflection'));
ALTER TABLE public.assistant_playbook_rules
  ADD COLUMN workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN research_scope text CHECK (research_scope IN ('user', 'project', 'workspace')),
  ADD COLUMN applies_to_project_id uuid REFERENCES public.workspace_projects(id) ON DELETE CASCADE,
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
-- Research rules carry a server-owned scope; other rules never do.
ALTER TABLE public.assistant_playbook_rules ADD CONSTRAINT assistant_playbook_rules_research_scope CHECK (
  (applicability_kind = 'research') = (research_scope IS NOT NULL)
  AND (research_scope IS NULL OR (
    workspace_id IS NOT NULL AND semantic_key IS NOT NULL AND created_by = 'research_reflection'
    AND CASE research_scope
          WHEN 'user' THEN applies_to_user_id IS NOT NULL AND applies_to_project_id IS NULL
          WHEN 'project' THEN applies_to_project_id IS NOT NULL AND applies_to_user_id IS NULL
          ELSE applies_to_user_id IS NULL AND applies_to_project_id IS NULL
        END)));
-- One research rule per (scope target, semantic key) regardless of the
-- originating assistant: a user lesson follows its user, not an assistant.
CREATE UNIQUE INDEX idx_playbook_research_semantic_key ON public.assistant_playbook_rules (
  workspace_id, research_scope,
  coalesce(applies_to_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(applies_to_project_id, '00000000-0000-0000-0000-000000000000'::uuid),
  semantic_key)
  WHERE applicability_kind = 'research';
CREATE INDEX idx_playbook_research_select ON public.assistant_playbook_rules (workspace_id, research_scope, status)
  WHERE applicability_kind = 'research';

COMMIT;
