BEGIN;

-- Permission model v2, Phase 2: the reference READ of platform
-- docs/plans/permission-model-v2.md §4 as row-level security, behind a
-- per-workspace flag (workspaces.department_read_v2, default false). It lives
-- on workspaces, which every schema has, so code reading it through to_jsonb
-- sees "off" on any older schema instead of raising. With the flag off nothing below changes a single read: the v2 policy
-- passes and the legacy member floor applies exactly as in 615. With it on,
-- the v2 policy decides department, tier, context, binding and the private
-- leg, and the legacy member floor stands aside for that workspace.
-- Spec: docs/architecture/context-engine/scoped-context.md -> "Reference predicate (v2)".
-- Graded by invariants/read-predicate-parity against
-- use-brian/packages/api/src/context-scope/reference-predicate.ts.

-- Same lock discipline as 615: all ten hot tables up front, one 5 s budget.
SET LOCAL statement_timeout = '5s';
LOCK TABLE memories, memories_shadow, entities, entity_links, tasks, workspace_files,
  episodes, knowledge_entries, kb_chunks IN ACCESS EXCLUSIVE MODE;
SET LOCAL statement_timeout TO DEFAULT;

ALTER TABLE workspaces ADD COLUMN department_read_v2 boolean NOT NULL DEFAULT false;

-- Statement-level, like 615 (the 09-29 per-row incident is the reference
-- failure): every policy wraps this in (SELECT ...), so it runs once per
-- statement as an InitPlan. One entry per v2 workspace the actor belongs to:
--   b  eff_base(P, A) rank       d  {department: eff(P, A, D) rank}
--   c  ctx.department or null    k  credential binding (JSON array) or null
--   u  P, for the private leg
-- P is app.current_user_id (the issuer under a credential). A is
-- app.v2_assistant_id; absent means no assistant acts, which is identity in
-- min(). app.v2_cap lowers everything; an unparseable cap admits nothing.
-- Ranks: public 1, internal 2, confidential 3; 0 is none.
CREATE FUNCTION department_read_grants()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH actor AS (
    SELECT nullif(current_setting('app.current_user_id', true), '')::uuid AS u,
           nullif(current_setting('app.v2_assistant_id', true), '')::uuid AS a,
           nullif(current_setting('app.v2_context_department', true), '') AS c,
           nullif(current_setting('app.v2_binding', true), '')::jsonb AS k,
           CASE WHEN nullif(current_setting('app.v2_cap', true), '') IS NULL THEN 3
                ELSE coalesce(sensitivity_rank(current_setting('app.v2_cap', true)), 0) END AS cap
  )
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'b', least(
             sensitivity_rank(CASE WHEN m.role IN ('owner', 'admin') THEN 'confidential' ELSE m.clearance END),
             CASE WHEN actor.a IS NULL THEN 3
                  ELSE coalesce((SELECT sensitivity_rank(x.clearance) FROM assistants x
                                  WHERE x.id = actor.a AND x.workspace_id = m.workspace_id), 0) END,
             actor.cap),
      'd', coalesce((
             SELECT jsonb_object_agg(e.department_id::text, least(
                      sensitivity_rank(e.clearance),
                      CASE WHEN actor.a IS NULL THEN 3 ELSE coalesce(sensitivity_rank(ae.clearance), 0) END,
                      actor.cap))
               FROM department_edges e
               LEFT JOIN department_edges ae
                 ON ae.department_id = e.department_id AND ae.assistant_id = actor.a
                AND (ae.expires_at IS NULL OR ae.expires_at > clock_timestamp())
              WHERE e.workspace_id = m.workspace_id AND e.user_id = actor.u
                AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())), '{}'::jsonb),
      'c', actor.c,
      'k', actor.k,
      'u', actor.u)), '{}'::jsonb)
    FROM actor
    JOIN workspace_members m ON m.user_id = actor.u
    JOIN workspaces wk ON wk.id = m.workspace_id AND wk.department_read_v2
$$;

-- READ(P, A, R, ctx) per row; reads no table. A workspace absent from the
-- map is not this policy's business (flag off, or the actor is no member and
-- the membership policies refuse). Department ids are the Team compartment
-- keys ('team:<uuid>'); any other compartment key fails closed. Unknown
-- sensitivity, a NULL element and a malformed map all deny.
CREATE FUNCTION department_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[], row_user uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN w IS NULL OR NOT (grants ? w::text) THEN true ELSE coalesce((
    SELECT public.sensitivity_rank(sensitivity) IS NOT NULL
       AND (row_user IS NULL OR row_user::text = (g.v ->> 'u'))
       AND NOT coalesce(ds.foreign_key, false)
       AND CASE WHEN ds.ids IS NULL
                THEN public.sensitivity_rank(sensitivity) <= (g.v ->> 'b')::int
                ELSE NOT EXISTS (SELECT 1 FROM unnest(ds.ids) AS d(id)
                                  WHERE NOT coalesce(public.sensitivity_rank(sensitivity) <= ((g.v -> 'd') ->> d.id)::int, false))
           END
       AND (jsonb_typeof(g.v -> 'c') IS DISTINCT FROM 'string' OR ds.ids IS NULL OR (g.v ->> 'c') = ANY (ds.ids))
       AND (jsonb_typeof(g.v -> 'k') IS DISTINCT FROM 'array' OR ds.ids IS NULL
            OR ds.ids <@ ARRAY(SELECT jsonb_array_elements_text(g.v -> 'k')))
      FROM (SELECT grants -> w::text AS v) g,
           (SELECT array_agg(substr(k, 6)) FILTER (WHERE k LIKE 'team:%') AS ids,
                   bool_or(k IS NULL OR k NOT LIKE 'team:%') AS foreign_key
              FROM unnest(coalesce(compartments, '{}'::text[])) AS k) ds
  ), false) END
$$;

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['memories','memories_shadow','entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'] LOOP
    EXECUTE format('CREATE POLICY department_read_v2 ON %I AS RESTRICTIVE FOR SELECT USING (department_row_allows((SELECT department_read_grants()), workspace_id, sensitivity, compartments, %s))',
      tab, CASE WHEN tab = 'knowledge_entries' THEN 'NULL::uuid' ELSE 'user_id' END);
    -- The legacy floor stands aside only where the v2 map holds the workspace.
    EXECUTE format('ALTER POLICY member_operation_read ON %I USING (member_operation_row_allows((SELECT member_operation_grants(false)), workspace_id, sensitivity, compartments) OR ((SELECT department_read_grants()) ? workspace_id::text))', tab);
  END LOOP;
END $$;

COMMIT;
