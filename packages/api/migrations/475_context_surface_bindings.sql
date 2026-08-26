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
ALTER TABLE public.pending_ingest_batches
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
CREATE INDEX pending_ingest_batches_context_due_idx
  ON public.pending_ingest_batches (workspace_id, fires_at)
  WHERE processed_at IS NULL;

-- Connector batches snapshot their rule stamp at enqueue. Room batches have
-- no ingest_rules row and supply their immutable session stamp directly.
-- Episode writers in hosted and OSS paths already carry rule_id in source_ref;
-- this trigger makes the persisted root authoritative before Pipeline B reads
-- it, without provider-specific authority code.
CREATE FUNCTION public.inherit_episode_ingest_context_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  source_rule text := NEW.source_ref->>'rule_id';
  inherited_compartments text[];
  inherited_projects uuid[];
BEGIN
  IF source_rule IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT b.compartments, b.project_ids
    INTO inherited_compartments, inherited_projects
    FROM public.pending_ingest_batches b
   WHERE b.rule_id::text = source_rule
     AND b.workspace_id = NEW.workspace_id
     AND b.processed_at IS NULL
   ORDER BY b.fires_at, b.created_at
   LIMIT 1;

  IF NOT FOUND THEN
    SELECT r.compartments, r.project_ids
      INTO inherited_compartments, inherited_projects
      FROM public.ingest_rules r
      JOIN public.connector_instance ci ON ci.id = r.connector_instance_id
     WHERE r.id::text = source_rule
       AND (
         ci.workspace_id = NEW.workspace_id
         OR EXISTS (
           SELECT 1 FROM public.connector_grant cg
            WHERE cg.connector_instance_id = ci.id
              AND cg.target_type = 'workspace'
              AND cg.target_id = NEW.workspace_id
         )
       )
     LIMIT 1;
  END IF;

  NEW.compartments := ARRAY(
    SELECT DISTINCT value
      FROM unnest(COALESCE(NEW.compartments, '{}'::text[])
               || COALESCE(inherited_compartments, '{}'::text[])) value
     ORDER BY value
  );
  NEW.project_ids := ARRAY(
    SELECT DISTINCT value
      FROM unnest(COALESCE(NEW.project_ids, '{}'::uuid[])
               || COALESCE(inherited_projects, '{}'::uuid[])) value
     ORDER BY value
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER episodes_context_ingest_inherit
  BEFORE INSERT ON public.episodes
  FOR EACH ROW EXECUTE FUNCTION public.inherit_episode_ingest_context_scope();

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

-- Linked Teamspaces derive human access from the flat Team grant. Unlinked
-- Teamspaces retain their explicit roster exactly.
DROP POLICY teamspaces_member ON public.teamspaces;
CREATE POLICY teamspaces_member ON public.teamspaces
  FOR SELECT
  USING (
    (
      workspace_group_id IS NULL
      AND id IN (
        SELECT tm.teamspace_id
          FROM public.teamspace_members tm
         WHERE tm.user_id = (current_setting('app.current_user_id', true))::uuid
      )
    )
    OR (
      workspace_group_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM public.workspace_groups g
         WHERE g.id = teamspaces.workspace_group_id
           AND (
             public.effective_member_team_compartments(
               (current_setting('app.current_user_id', true))::uuid,
               teamspaces.workspace_id
             ) IS NULL
             OR ARRAY[g.compartment_key]::text[] <@
                public.effective_member_team_compartments(
                  (current_setting('app.current_user_id', true))::uuid,
                  teamspaces.workspace_id
                )
           )
      )
    )
  );

-- Page access composes the human Team grant with the trusted assistant GUCs.
-- A clearance-only legacy agent wrap can still enter unlinked Teamspaces, but
-- linked Teamspaces fail closed until both clearance and compartments exist.
DROP POLICY saved_views_workspace_member ON public.saved_views;
CREATE POLICY saved_views_workspace_member ON public.saved_views
  USING (
    workspace_id IN (
      SELECT wm.workspace_id
        FROM public.workspace_members wm
       WHERE wm.user_id = (current_setting('app.current_user_id', true))::uuid
    )
    AND (
      (teamspace_id IS NULL
        AND created_by = (current_setting('app.current_user_id', true))::uuid)
      OR EXISTS (
        SELECT 1
          FROM public.teamspaces t
         WHERE t.id = saved_views.teamspace_id
           AND (
             (
               t.workspace_group_id IS NULL
               AND (
                 (
                   NULLIF(current_setting('app.agent_clearance', true), '') IS NULL
                   AND EXISTS (
                     SELECT 1 FROM public.teamspace_members tm
                      WHERE tm.teamspace_id = t.id
                        AND tm.user_id = (current_setting('app.current_user_id', true))::uuid
                   )
                 )
                 OR (
                   NULLIF(current_setting('app.agent_clearance', true), '') IS NOT NULL
                   AND public.sensitivity_rank(t.sensitivity)
                       <= public.sensitivity_rank(current_setting('app.agent_clearance', true))
                 )
               )
             )
             OR (
               t.workspace_group_id IS NOT NULL
               AND EXISTS (
                 SELECT 1
                   FROM public.workspace_groups g
                  WHERE g.id = t.workspace_group_id
                    AND (
                      (
                        NULLIF(current_setting('app.agent_clearance', true), '') IS NULL
                        AND (
                        public.effective_member_team_compartments(
                          (current_setting('app.current_user_id', true))::uuid,
                          t.workspace_id
                        ) IS NULL
                        OR ARRAY[g.compartment_key]::text[] <@
                           public.effective_member_team_compartments(
                             (current_setting('app.current_user_id', true))::uuid,
                             t.workspace_id
                           )
                        )
                      )
                      OR (
                        NULLIF(current_setting('app.agent_clearance', true), '') IS NOT NULL
                        AND NULLIF(current_setting('app.agent_compartments', true), '') IS NOT NULL
                        AND public.sensitivity_rank(t.sensitivity)
                            <= public.sensitivity_rank(current_setting('app.agent_clearance', true))
                        AND (
                          current_setting('app.agent_compartments', true)::jsonb = 'null'::jsonb
                          OR current_setting('app.agent_compartments', true)::jsonb ? g.compartment_key
                        )
                      )
                    )
               )
             )
           )
      )
    )
    AND (
      NULLIF(current_setting('app.agent_clearance', true), '') IS NULL
      OR NULLIF(current_setting('app.agent_project_ids', true), '') IS NULL
      OR current_setting('app.agent_project_ids', true)::jsonb = 'null'::jsonb
      OR project_id IS NULL
      OR current_setting('app.agent_project_ids', true)::jsonb ? project_id::text
    )
  );

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
CREATE TRIGGER pending_ingest_batches_context_scope_valid
  BEFORE INSERT OR UPDATE OF workspace_id, compartments, project_ids
  ON public.pending_ingest_batches
  FOR EACH ROW EXECUTE FUNCTION public.validate_context_scope_arrays(
    'workspace_id', 'compartments', 'project_ids'
  );

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
