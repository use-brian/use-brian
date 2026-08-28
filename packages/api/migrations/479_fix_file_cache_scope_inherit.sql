-- 474's inherit_file_cache_context_scope() selected context_project_ids from
-- public.sessions, but that plural array exists only on workflow_runs and
-- scheduled_jobs -- sessions carries the singular context_project_id (473).
-- CREATE FUNCTION never validates a plpgsql body's SQL, so the typo shipped
-- silently and every file_cache INSERT then failed 42703 at trigger time,
-- which broke chat file uploads (per-file "Failed to parse" errors) and
-- channel-side file caching platform-wide. Replace the function to read the
-- real column and project it into the array shape scope inheritance expects.
-- Spec: docs/architecture/context-engine/scoped-context.md.

BEGIN;

CREATE OR REPLACE FUNCTION public.inherit_file_cache_context_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  parent_compartments text[];
  parent_project uuid;
BEGIN
  SELECT context_compartments, context_project_id
    INTO parent_compartments, parent_project
    FROM public.sessions WHERE id = NEW.session_id;
  NEW.compartments := ARRAY(
    SELECT DISTINCT unnest(COALESCE(parent_compartments, '{}'::text[]) || NEW.compartments)
    ORDER BY 1
  );
  NEW.project_ids := ARRAY(
    SELECT DISTINCT unnest(
      CASE WHEN parent_project IS NULL THEN '{}'::uuid[] ELSE ARRAY[parent_project] END
      || NEW.project_ids
    )
    ORDER BY 1
  );
  RETURN NEW;
END;
$$;

COMMIT;
