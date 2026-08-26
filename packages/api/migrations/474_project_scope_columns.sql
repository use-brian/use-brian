-- Project requirements on every discoverable row and context snapshots on
-- operational roots. Empty arrays are Workspace General, never universe.
-- Spec: docs/architecture/context-engine/scoped-context.md.

BEGIN;

ALTER TABLE public.memories ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.tasks
  ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT tasks_one_project_check CHECK (cardinality(project_ids) <= 1);
ALTER TABLE public.workspace_files ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.entities ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.entity_links ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.episodes ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.file_cache ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.knowledge_entries ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.kb_chunks ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.file_segments ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.transcript_segments ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.recordings ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX memories_project_ids_gin ON public.memories USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX tasks_project_ids_gin ON public.tasks USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX workspace_files_project_ids_gin ON public.workspace_files USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX entities_project_ids_gin ON public.entities USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX entity_links_project_ids_gin ON public.entity_links USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX episodes_project_ids_gin ON public.episodes USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX file_cache_project_ids_gin ON public.file_cache USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX knowledge_entries_project_ids_gin ON public.knowledge_entries USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX kb_chunks_project_ids_gin ON public.kb_chunks USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX file_segments_project_ids_gin ON public.file_segments USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX transcript_segments_project_ids_gin ON public.transcript_segments USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX recordings_project_ids_gin ON public.recordings USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;

ALTER TABLE public.saved_views
  ADD COLUMN project_id uuid REFERENCES public.workspace_projects(id) ON DELETE SET NULL;
CREATE INDEX saved_views_project_idx ON public.saved_views (workspace_id, project_id)
  WHERE project_id IS NOT NULL;

ALTER TABLE public.entity_instances
  ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
    CHECK (sensitivity IN ('public', 'internal', 'confidential')),
  ADD COLUMN user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN assistant_id uuid REFERENCES public.assistants(id) ON DELETE SET NULL,
  ADD COLUMN compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX entity_instances_compartments_gin
  ON public.entity_instances USING gin (compartments)
  WHERE cardinality(compartments) > 0;
CREATE INDEX entity_instances_project_ids_gin
  ON public.entity_instances USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;

ALTER TABLE public.blueprint_records
  ADD COLUMN compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX blueprint_records_compartments_gin
  ON public.blueprint_records USING gin (compartments)
  WHERE cardinality(compartments) > 0;
CREATE INDEX blueprint_records_project_ids_gin
  ON public.blueprint_records USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;

-- Office called this column required_compartments before the universal engine
-- vocabulary settled on compartments. Preserve data while converging the root.
ALTER TABLE public.office_artifacts
  RENAME COLUMN required_compartments TO compartments;
ALTER TABLE public.office_artifacts
  ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX office_artifacts_compartments_gin
  ON public.office_artifacts USING gin (compartments)
  WHERE cardinality(compartments) > 0;
CREATE INDEX office_artifacts_project_ids_gin
  ON public.office_artifacts USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;

ALTER TABLE public.workflows
  ADD COLUMN context_group_id uuid REFERENCES public.workspace_groups(id) ON DELETE SET NULL,
  ADD COLUMN context_project_id uuid REFERENCES public.workspace_projects(id) ON DELETE SET NULL;
ALTER TABLE public.workflow_runs
  ADD COLUMN context_group_id uuid REFERENCES public.workspace_groups(id) ON DELETE SET NULL,
  ADD COLUMN context_project_id uuid REFERENCES public.workspace_projects(id) ON DELETE SET NULL,
  ADD COLUMN context_compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN context_project_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE public.goals
  ADD COLUMN context_group_id uuid REFERENCES public.workspace_groups(id) ON DELETE SET NULL,
  ADD COLUMN context_project_id uuid REFERENCES public.workspace_projects(id) ON DELETE SET NULL;

ALTER TABLE public.scheduled_jobs
  ADD COLUMN context_group_id uuid REFERENCES public.workspace_groups(id) ON DELETE SET NULL,
  ADD COLUMN context_project_id uuid REFERENCES public.workspace_projects(id) ON DELETE SET NULL,
  ADD COLUMN context_compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN context_project_ids uuid[] NOT NULL DEFAULT '{}';

-- Derived/background rows copy their root scope inside the database. This is
-- the final guard against a worker retry or an older call site silently
-- defaulting a scoped derivative to Workspace General.
CREATE FUNCTION public.inherit_file_cache_context_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  parent_compartments text[];
  parent_projects uuid[];
BEGIN
  SELECT context_compartments, context_project_ids
    INTO parent_compartments, parent_projects
    FROM public.sessions WHERE id = NEW.session_id;
  NEW.compartments := ARRAY(
    SELECT DISTINCT unnest(COALESCE(parent_compartments, '{}'::text[]) || NEW.compartments)
    ORDER BY 1
  );
  NEW.project_ids := ARRAY(
    SELECT DISTINCT unnest(COALESCE(parent_projects, '{}'::uuid[]) || NEW.project_ids)
    ORDER BY 1
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER file_cache_context_scope_inherit
  BEFORE INSERT ON public.file_cache
  FOR EACH ROW EXECUTE FUNCTION public.inherit_file_cache_context_scope();

CREATE FUNCTION public.inherit_recording_context_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  SELECT e.compartments, e.project_ids
    INTO NEW.compartments, NEW.project_ids
    FROM public.episodes e WHERE e.id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER recordings_context_scope_inherit
  BEFORE INSERT ON public.recordings
  FOR EACH ROW EXECUTE FUNCTION public.inherit_recording_context_scope();

CREATE FUNCTION public.inherit_transcript_segment_context_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  SELECT e.compartments, e.project_ids
    INTO NEW.compartments, NEW.project_ids
    FROM public.episodes e WHERE e.id = NEW.recording_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transcript_segments_context_scope_inherit
  BEFORE INSERT ON public.transcript_segments
  FOR EACH ROW EXECUTE FUNCTION public.inherit_transcript_segment_context_scope();

CREATE FUNCTION public.inherit_file_segment_context_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  SELECT f.compartments, f.project_ids
    INTO NEW.compartments, NEW.project_ids
    FROM public.workspace_files f WHERE f.id = NEW.file_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER file_segments_context_scope_inherit
  BEFORE INSERT ON public.file_segments
  FOR EACH ROW EXECUTE FUNCTION public.inherit_file_segment_context_scope();

-- Reusable validator for row-local Team requirements and Project UUID arrays.
-- Only the reserved team: namespace is registry-backed; legacy and client:
-- compartments keep their existing validation paths.
CREATE FUNCTION public.validate_context_scope_arrays() RETURNS trigger
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

CREATE TRIGGER memories_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER tasks_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER workspace_files_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.workspace_files
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER entities_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER entity_links_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.entity_links
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER episodes_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.episodes
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER file_cache_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.file_cache
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER knowledge_entries_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER kb_chunks_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.kb_chunks
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER file_segments_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.file_segments
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER transcript_segments_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.transcript_segments
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER recordings_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.recordings
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER entity_instances_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.entity_instances
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER blueprint_records_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.blueprint_records
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER office_artifacts_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids ON public.office_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'compartments', 'project_ids');
CREATE TRIGGER workflow_runs_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, context_compartments, context_project_ids
  ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('workspace_id', 'context_compartments', 'context_project_ids');
CREATE TRIGGER scheduled_jobs_context_scope_valid
  BEFORE INSERT OR UPDATE OF assistant_id, context_compartments, context_project_ids
  ON public.scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays('assistant_workspace', 'context_compartments', 'context_project_ids');

CREATE FUNCTION public.validate_operational_context_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  payload jsonb := to_jsonb(NEW);
  workspace_value uuid;
  group_value uuid;
  project_value uuid;
BEGIN
  workspace_value := NULLIF(payload ->> TG_ARGV[0], '')::uuid;
  IF workspace_value IS NULL AND TG_ARGV[0] = 'assistant_workspace' THEN
    SELECT workspace_id INTO workspace_value
      FROM public.assistants WHERE id = (payload ->> 'assistant_id')::uuid;
  END IF;
  group_value := NULLIF(payload ->> 'context_group_id', '')::uuid;
  project_value := NULLIF(payload ->> 'context_project_id', '')::uuid;

  IF group_value IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_groups g
     WHERE g.id = group_value AND g.workspace_id = workspace_value AND g.kind = 'team'
  ) THEN
    RAISE EXCEPTION 'operational Team binding must stay within one workspace';
  END IF;
  IF project_value IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_projects p
     WHERE p.id = project_value AND p.workspace_id = workspace_value
  ) THEN
    RAISE EXCEPTION 'operational Project binding must stay within one workspace';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflows_context_binding_valid
  BEFORE INSERT OR UPDATE OF workspace_id, context_group_id, context_project_id
  ON public.workflows FOR EACH ROW
  EXECUTE FUNCTION public.validate_operational_context_binding('workspace_id');
CREATE TRIGGER workflow_runs_context_binding_valid
  BEFORE INSERT OR UPDATE OF workspace_id, context_group_id, context_project_id
  ON public.workflow_runs FOR EACH ROW
  EXECUTE FUNCTION public.validate_operational_context_binding('workspace_id');
CREATE TRIGGER goals_context_binding_valid
  BEFORE INSERT OR UPDATE OF workspace_id, context_group_id, context_project_id
  ON public.goals FOR EACH ROW
  EXECUTE FUNCTION public.validate_operational_context_binding('workspace_id');
CREATE TRIGGER scheduled_jobs_context_binding_valid
  BEFORE INSERT OR UPDATE OF assistant_id, context_group_id, context_project_id
  ON public.scheduled_jobs FOR EACH ROW
  EXECUTE FUNCTION public.validate_operational_context_binding('assistant_workspace');

CREATE FUNCTION public.validate_saved_view_project() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_projects p
     WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'page Project must stay within the page workspace';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER saved_views_project_workspace_match
  BEFORE INSERT OR UPDATE OF workspace_id, project_id ON public.saved_views
  FOR EACH ROW EXECUTE FUNCTION public.validate_saved_view_project();

-- Container/root RLS uses the same Team + Project set algebra as the
-- universal TypeScript predicate. Human page/entity/Office reads receive the
-- member Team union and no Project filter; assistant executions receive the
-- trusted GUC projection resolved at the model-entry boundary.
CREATE FUNCTION public.context_scope_allows_current_principal(
  p_workspace_id uuid,
  p_sensitivity text,
  p_compartments text[],
  p_project_ids uuid[]
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  member_clearance text;
  team_grant text[];
  agent_clearance text := NULLIF(current_setting('app.agent_clearance', true), '');
  agent_teams jsonb;
  agent_projects jsonb;
BEGIN
  SELECT wm.clearance INTO member_clearance
    FROM public.workspace_members wm
   WHERE wm.workspace_id = p_workspace_id
     AND wm.user_id = current_setting('app.current_user_id', true)::uuid;
  IF member_clearance IS NULL THEN RETURN false; END IF;

  IF agent_clearance IS NULL THEN
    IF public.sensitivity_rank(p_sensitivity) > public.sensitivity_rank(member_clearance) THEN
      RETURN false;
    END IF;
    team_grant := public.effective_member_team_compartments(
      current_setting('app.current_user_id', true)::uuid,
      p_workspace_id
    );
    RETURN team_grant IS NULL OR COALESCE(p_compartments, '{}') <@ team_grant;
  END IF;

  IF public.sensitivity_rank(p_sensitivity) > public.sensitivity_rank(agent_clearance) THEN
    RETURN false;
  END IF;
  IF NULLIF(current_setting('app.agent_compartments', true), '') IS NOT NULL THEN
    agent_teams := current_setting('app.agent_compartments', true)::jsonb;
    IF agent_teams <> 'null'::jsonb AND NOT (
      SELECT COALESCE(bool_and(agent_teams ? value), true)
        FROM unnest(COALESCE(p_compartments, '{}')) AS u(value)
    ) THEN RETURN false; END IF;
  END IF;
  IF NULLIF(current_setting('app.agent_project_ids', true), '') IS NOT NULL THEN
    agent_projects := current_setting('app.agent_project_ids', true)::jsonb;
    IF agent_projects <> 'null'::jsonb AND NOT (
      SELECT COALESCE(bool_and(agent_projects ? value::text), true)
        FROM unnest(COALESCE(p_project_ids, '{}')) AS u(value)
    ) THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

DROP POLICY entity_instances_workspace_member ON public.entity_instances;
CREATE POLICY entity_instances_context_member ON public.entity_instances
  USING (public.context_scope_allows_current_principal(
    workspace_id, sensitivity, compartments, project_ids
  ));

DROP POLICY blueprint_records_workspace_member ON public.blueprint_records;
CREATE POLICY blueprint_records_context_member ON public.blueprint_records
  USING (public.context_scope_allows_current_principal(
    workspace_id, sensitivity, compartments, project_ids
  ));

DROP POLICY office_artifacts_member ON public.office_artifacts;
CREATE POLICY office_artifacts_context_member ON public.office_artifacts
  USING (public.context_scope_allows_current_principal(
    workspace_id, sensitivity, compartments, project_ids
  ));
DROP POLICY office_versions_member ON public.office_artifact_versions;
CREATE POLICY office_versions_context_member ON public.office_artifact_versions
  USING (EXISTS (
    SELECT 1 FROM public.office_artifacts a
     WHERE a.id = office_artifact_versions.artifact_id
       AND public.context_scope_allows_current_principal(
         a.workspace_id, a.sensitivity, a.compartments, a.project_ids
       )
  ));
DROP POLICY office_sources_member ON public.office_artifact_sources;
CREATE POLICY office_sources_context_member ON public.office_artifact_sources
  USING (EXISTS (
    SELECT 1 FROM public.office_artifacts a
     WHERE a.id = office_artifact_sources.artifact_id
       AND public.context_scope_allows_current_principal(
         a.workspace_id, a.sensitivity, a.compartments, a.project_ids
       )
  ));

CREATE FUNCTION public.inherit_office_source_root_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  root_sensitivity text;
  root_compartments text[];
BEGIN
  SELECT a.sensitivity, a.compartments
    INTO root_sensitivity, root_compartments
    FROM public.office_artifacts a WHERE a.id = NEW.artifact_id;
  NEW.sensitivity := CASE
    WHEN public.sensitivity_rank(COALESCE(NEW.sensitivity, 'public'))
       >= public.sensitivity_rank(COALESCE(root_sensitivity, 'public'))
      THEN NEW.sensitivity ELSE root_sensitivity END;
  NEW.required_compartments := ARRAY(
    SELECT DISTINCT value
      FROM unnest(COALESCE(NEW.required_compartments, '{}') ||
                  COALESCE(root_compartments, '{}')) AS u(value)
     ORDER BY value
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER office_sources_root_scope_inherit
  BEFORE INSERT OR UPDATE OF artifact_id, sensitivity, required_compartments
  ON public.office_artifact_sources
  FOR EACH ROW EXECUTE FUNCTION public.inherit_office_source_root_scope();

CREATE FUNCTION public.raise_office_root_from_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  UPDATE public.office_artifacts a
     SET sensitivity = CASE
           WHEN public.sensitivity_rank(a.sensitivity) >= public.sensitivity_rank(NEW.sensitivity)
             THEN a.sensitivity ELSE NEW.sensitivity END,
         compartments = ARRAY(
           SELECT DISTINCT value
             FROM unnest(a.compartments || NEW.required_compartments) AS u(value)
            ORDER BY value
         ),
         updated_at = now()
   WHERE a.id = NEW.artifact_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER office_sources_raise_root_scope
  AFTER INSERT OR UPDATE OF sensitivity, required_compartments
  ON public.office_artifact_sources
  FOR EACH ROW EXECUTE FUNCTION public.raise_office_root_from_source();

COMMIT;
