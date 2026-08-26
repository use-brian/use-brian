-- Teamspace, connector, ingest, and legacy task Project bindings.
-- Spec: docs/architecture/context-engine/scoped-context.md.

BEGIN;

ALTER TABLE public.teamspaces
  ADD COLUMN workspace_group_id uuid
    REFERENCES public.workspace_groups(id) ON DELETE SET NULL;
CREATE INDEX teamspaces_workspace_group_idx
  ON public.teamspaces (workspace_id, workspace_group_id)
  WHERE workspace_group_id IS NOT NULL;

ALTER TABLE public.connector_instance
  ADD COLUMN compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT connector_instance_context_workspace_only CHECK (
    scope = 'workspace'
    OR (cardinality(compartments) = 0 AND cardinality(project_ids) = 0)
  );
ALTER TABLE public.connector_grant
  ADD COLUMN compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.ingest_rules
  ADD COLUMN compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX connector_instance_compartments_gin
  ON public.connector_instance USING gin (compartments)
  WHERE cardinality(compartments) > 0;
CREATE INDEX connector_instance_project_ids_gin
  ON public.connector_instance USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX connector_grant_compartments_gin
  ON public.connector_grant USING gin (compartments)
  WHERE cardinality(compartments) > 0;
CREATE INDEX connector_grant_project_ids_gin
  ON public.connector_grant USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;
CREATE INDEX ingest_rules_compartments_gin
  ON public.ingest_rules USING gin (compartments)
  WHERE cardinality(compartments) > 0;
CREATE INDEX ingest_rules_project_ids_gin
  ON public.ingest_rules USING gin (project_ids)
  WHERE cardinality(project_ids) > 0;

CREATE FUNCTION public.validate_teamspace_context_group() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.workspace_group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workspace_groups g
     WHERE g.id = NEW.workspace_group_id
       AND g.workspace_id = NEW.workspace_id
       AND g.kind = 'team'
  ) THEN
    RAISE EXCEPTION 'teamspace Team must belong to its workspace';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER teamspaces_context_group_valid
  BEFORE INSERT OR UPDATE OF workspace_id, workspace_group_id
  ON public.teamspaces
  FOR EACH ROW EXECUTE FUNCTION public.validate_teamspace_context_group();

CREATE FUNCTION public.prevent_linked_teamspace_roster_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  target_teamspace uuid := COALESCE(NEW.teamspace_id, OLD.teamspace_id);
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.teamspaces
     WHERE id = target_teamspace AND workspace_group_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'linked_teamspace_roster_is_derived';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER teamspace_members_linked_roster_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.teamspace_members
  FOR EACH ROW EXECUTE FUNCTION public.prevent_linked_teamspace_roster_mutation();

CREATE FUNCTION public.validate_connector_context_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  workspace_value uuid;
  compartment_values text[];
  project_values uuid[];
BEGIN
  IF TG_TABLE_NAME = 'connector_instance' THEN
    workspace_value := NEW.workspace_id;
  ELSIF TG_TABLE_NAME = 'connector_grant' THEN
    IF NEW.target_type <> 'workspace' THEN
      RAISE EXCEPTION 'context-bound connector grants require a workspace target';
    END IF;
    workspace_value := NEW.target_id;
  ELSE
    SELECT CASE
      WHEN ci.scope = 'workspace' THEN ci.workspace_id
      ELSE (
        SELECT cg.target_id FROM public.connector_grant cg
         WHERE cg.connector_instance_id = ci.id
           AND cg.target_type = 'workspace'
         ORDER BY cg.granted_at
         LIMIT 1
      )
    END INTO workspace_value
    FROM public.connector_instance ci
    WHERE ci.id = NEW.connector_instance_id;
  END IF;

  compartment_values := COALESCE(NEW.compartments, ARRAY[]::text[]);
  project_values := COALESCE(NEW.project_ids, ARRAY[]::uuid[]);
  IF workspace_value IS NULL
     AND (cardinality(compartment_values) > 0 OR cardinality(project_values) > 0) THEN
    RAISE EXCEPTION 'scoped connector surfaces require a workspace';
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
    RAISE EXCEPTION 'connector Team requirements must stay within one workspace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(project_values) project_id
     WHERE NOT EXISTS (
       SELECT 1 FROM public.workspace_projects p
        WHERE p.id = project_id AND p.workspace_id = workspace_value
     )
  ) THEN
    RAISE EXCEPTION 'connector Project requirements must stay within one workspace';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_instance_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids
  ON public.connector_instance
  FOR EACH ROW EXECUTE FUNCTION public.validate_connector_context_scope();
CREATE TRIGGER connector_grant_context_scope_valid
  BEFORE INSERT OR UPDATE OF target_type, target_id, compartments, project_ids
  ON public.connector_grant
  FOR EACH ROW EXECUTE FUNCTION public.validate_connector_context_scope();
CREATE TRIGGER ingest_rules_context_scope_valid
  BEFORE INSERT OR UPDATE OF connector_instance_id, compartments, project_ids
  ON public.ingest_rules
  FOR EACH ROW EXECUTE FUNCTION public.validate_connector_context_scope();

-- Freeze the SQL half of normalizeProjectName: trim, then lowercase. When a
-- task has multiple valid Project tags v1 consumes the first array occurrence
-- and leaves the rest visible to readiness instead of guessing.
CREATE TEMP TABLE context_task_project_backfill ON COMMIT DROP AS
SELECT DISTINCT ON (t.id)
       t.id AS task_id,
       t.workspace_id,
       tag.value AS consumed_tag,
       btrim(substr(tag.value, 9)) AS display_name,
       lower(btrim(substr(tag.value, 9))) AS normalized_name,
       t.created_at,
       tag.ordinality
  FROM public.tasks t
 CROSS JOIN LATERAL unnest(t.tags) WITH ORDINALITY AS tag(value, ordinality)
 WHERE t.valid_to IS NULL
   AND t.retracted_at IS NULL
   AND lower(tag.value) LIKE 'project:%'
   AND length(btrim(substr(tag.value, 9))) > 0
 ORDER BY t.id, tag.ordinality;

INSERT INTO public.workspace_projects
  (workspace_id, name, normalized_name, created_by, created_at, updated_at)
SELECT DISTINCT ON (b.workspace_id, b.normalized_name)
       b.workspace_id,
       b.display_name,
       b.normalized_name,
       w.owner_user_id,
       b.created_at,
       b.created_at
  FROM context_task_project_backfill b
  JOIN public.workspaces w ON w.id = b.workspace_id
 ORDER BY b.workspace_id, b.normalized_name, b.created_at, b.task_id
ON CONFLICT (workspace_id, normalized_name) DO NOTHING;

UPDATE public.tasks t
   SET project_ids = ARRAY[p.id]::uuid[],
       tags = array_remove(t.tags, b.consumed_tag)
  FROM context_task_project_backfill b
  JOIN public.workspace_projects p
    ON p.workspace_id = b.workspace_id
   AND p.normalized_name = b.normalized_name
 WHERE t.id = b.task_id;

COMMIT;
