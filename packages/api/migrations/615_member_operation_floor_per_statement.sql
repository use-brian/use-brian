BEGIN;

-- ALTER POLICY takes an ACCESS EXCLUSIVE lock on ten hot tables. Take them all
-- up front under ONE 5 s budget: acquired one ALTER at a time, each wait would
-- queue readers of the tables already held. On timeout the whole file rolls
-- back and records nothing; retry when no long statement holds these tables.
SET LOCAL statement_timeout = '5s';
LOCK TABLE memories, memories_shadow, entities, entity_links, tasks, workspace_files,
  episodes, knowledge_entries, kb_chunks, file_cache IN ACCESS EXCLUSIVE MODE;
SET LOCAL statement_timeout TO DEFAULT;

-- Evaluate the current-member operation floor (migration 589) once per
-- statement instead of once per row. What the floor allows is unchanged.
--
-- RLS runs restrictive policy quals before any non-leakproof caller predicate
-- (e.g. lower(display_name) = ...), so a per-row call to the plpgsql
-- member_operation_scope_allows paid a workspace_members lookup plus the Team
-- and grant reach resolution for EVERY row a statement scanned: ~3.5 ms/row in
-- production, >10 s for a name lookup in a 3k-entity workspace.
--
--   member_operation_grants(mutation)   the actor's floor for every membership.
--                                       Each policy wraps it in (SELECT ...), so
--                                       PostgreSQL evaluates it once (InitPlan).
--   member_operation_row_allows(...)    pure per-row comparison; reads no table.
--
-- member_operation_scope_allows keeps its signature for scalar callers
-- (office_labels_scope_allows, saved_view_operation_scope_allows) and is
-- redefined on the same two functions, so the floor has one definition.
-- Spec: docs/architecture/context-engine/scoped-context.md ->
-- "Operation-specific execution ceilings".

-- Map of workspace_id -> {"r": clearance rank, "c": reach}. "c" is JSON null
-- for unrestricted reach, else the array of reachable compartment keys.
-- only_workspace narrows the map to one membership for scalar callers.
CREATE FUNCTION member_operation_grants(mutation boolean, only_workspace uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'r', sensitivity_rank(CASE WHEN m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END),
      'c', to_jsonb(CASE WHEN mutation THEN effective_member_team_compartments(m.user_id, m.workspace_id)
                         ELSE effective_member_read_compartments(m.user_id, m.workspace_id) END))), '{}'::jsonb)
    FROM workspace_members m
   WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
     AND (only_workspace IS NULL OR m.workspace_id = only_workspace)
$$;

-- 589 semantics, per row: deny without a membership, an unknown clearance or
-- sensitivity, or a sensitivity above clearance; then allow when reach is
-- unrestricted, else require compartments within reach. A NULL compartment
-- element never matches (text[] containment), so it is denied explicitly
-- before the jsonb containment, which would otherwise match JSON null. Both
-- checks are jsonb so a multidimensional array is denied rather than raising.
-- No SET search_path (a per-row GUC save/restore): qualify instead.
CREATE FUNCTION member_operation_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    public.sensitivity_rank(sensitivity) <= ((grants -> w::text) ->> 'r')::int
    AND (jsonb_typeof((grants -> w::text) -> 'c') = 'null'
         OR (NOT (to_jsonb(coalesce(compartments, '{}'::text[])) @> '[null]'::jsonb)
             AND to_jsonb(coalesce(compartments, '{}'::text[])) <@ ((grants -> w::text) -> 'c'))),
    false)
$$;

CREATE OR REPLACE FUNCTION member_operation_scope_allows(w uuid, sensitivity text, compartments text[], mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT member_operation_row_allows(member_operation_grants(mutation, w), w, sensitivity, compartments)
$$;

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['memories','memories_shadow','entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'] LOOP
    EXECUTE format('ALTER POLICY member_operation_read ON %I USING (member_operation_row_allows((SELECT member_operation_grants(false)), workspace_id, sensitivity, compartments))', tab);
    EXECUTE format('ALTER POLICY member_operation_insert ON %I WITH CHECK (member_operation_row_allows((SELECT member_operation_grants(true)), workspace_id, sensitivity, compartments))', tab);
    EXECUTE format('ALTER POLICY member_operation_update ON %I USING (member_operation_row_allows((SELECT member_operation_grants(true)), workspace_id, sensitivity, compartments)) WITH CHECK (member_operation_row_allows((SELECT member_operation_grants(true)), workspace_id, sensitivity, compartments))', tab);
    EXECUTE format('ALTER POLICY member_operation_delete ON %I USING (member_operation_row_allows((SELECT member_operation_grants(true)), workspace_id, sensitivity, compartments))', tab);
  END LOOP;
END $$;

-- file_cache floors (595): only the member-floor term changes.
ALTER POLICY file_cache_read_floor ON file_cache USING (
  expires_at > now() AND NOT scope_held
  AND (user_id IS NULL OR user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  AND member_operation_row_allows((SELECT member_operation_grants(false)), workspace_id, sensitivity, compartments));
ALTER POLICY file_cache_insert_floor ON file_cache WITH CHECK (
  member_operation_row_allows((SELECT member_operation_grants(true)), workspace_id, sensitivity, compartments)
  AND agent_mutation_scope_allows(compartments));
ALTER POLICY file_cache_update_floor ON file_cache USING (
  member_operation_row_allows((SELECT member_operation_grants(true)), workspace_id, sensitivity, compartments)
  AND agent_mutation_scope_allows(compartments))
  WITH CHECK (
  member_operation_row_allows((SELECT member_operation_grants(true)), workspace_id, sensitivity, compartments)
  AND agent_mutation_scope_allows(compartments));
ALTER POLICY file_cache_delete_floor ON file_cache USING (
  member_operation_row_allows((SELECT member_operation_grants(true)), workspace_id, sensitivity, compartments)
  AND agent_mutation_scope_allows(compartments));

COMMIT;
