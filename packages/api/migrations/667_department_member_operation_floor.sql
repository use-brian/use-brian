BEGIN;

-- The v2 read rollout retired the legacy base ceiling only for SELECT.
-- Use the same current department authority for the member mutation floor;
-- all other restrictive policies and canonical write admission remain.
-- Spec: docs/architecture/context-engine/scoped-context.md
-- "Departmental member operation floor".
CREATE OR REPLACE FUNCTION member_operation_grants(mutation boolean, only_workspace uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH departments AS MATERIALIZED (SELECT department_read_grants() AS grants)
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'r', sensitivity_rank(CASE WHEN m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END),
      'c', to_jsonb(CASE WHEN mutation THEN effective_member_team_compartments(m.user_id, m.workspace_id)
                         ELSE effective_member_read_compartments(m.user_id, m.workspace_id) END),
      'v2', departments.grants -> m.workspace_id::text)), '{}'::jsonb)
    FROM workspace_members m CROSS JOIN departments
   WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
     AND (only_workspace IS NULL OR m.workspace_id = only_workspace)
$$;

CREATE OR REPLACE FUNCTION member_operation_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof((grants -> w::text) -> 'v2') = 'object'
    THEN public.department_row_allows(jsonb_build_object(w::text, (grants -> w::text) -> 'v2'), w, sensitivity, compartments, NULL::uuid)
    ELSE coalesce(
      public.sensitivity_rank(sensitivity) <= ((grants -> w::text) ->> 'r')::int
      AND (jsonb_typeof((grants -> w::text) -> 'c') = 'null'
           OR (NOT (to_jsonb(coalesce(compartments, '{}'::text[])) @> '[null]'::jsonb)
               AND to_jsonb(coalesce(compartments, '{}'::text[])) <@ ((grants -> w::text) -> 'c'))),
      false)
    END
$$;

COMMIT;
