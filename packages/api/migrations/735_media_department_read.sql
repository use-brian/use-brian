-- [COMP:access/predicate-parity] Department read floor for the media and
-- segment families.
-- Spec: docs/architecture/context-engine/scoped-context.md -> "Reference
-- predicate (v2)" -> "Every discoverable family carries it".
-- Migration 649 installed the statement-level v2 read policy on the 589 table
-- set only. Recordings, transcript segments and file segments carried only
-- workspace membership and derivation-ancestry policies, and file_cache only
-- the legacy member floor, so in a v2 workspace any member (owner/admin
-- included) could read another department's recordings, transcripts and
-- segment text. Same policy, same private leg (the row's user_id). For a
-- workspace with the flag off the policy passes and nothing changes.
BEGIN;

SET LOCAL statement_timeout = '5s';
LOCK TABLE recordings, transcript_segments, file_segments, file_cache IN ACCESS EXCLUSIVE MODE;
SET LOCAL statement_timeout TO DEFAULT;

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['recordings','transcript_segments','file_segments','file_cache'] LOOP
    EXECUTE format('CREATE POLICY department_read_v2 ON %I AS RESTRICTIVE FOR SELECT USING (department_row_allows((SELECT department_read_grants()), workspace_id, sensitivity, compartments, user_id))', tab);
  END LOOP;
END $$;

-- file_cache's legacy floor stands aside where the v2 map holds the
-- workspace, exactly as 649 did for member_operation_read.
ALTER POLICY file_cache_read_floor ON file_cache USING (
  (expires_at > now()) AND (NOT scope_held)
  AND ((user_id IS NULL) OR (user_id = (NULLIF(current_setting('app.current_user_id', true), ''))::uuid))
  AND (member_operation_row_allows((SELECT member_operation_grants(false)), workspace_id, sensitivity, compartments)
       OR ((SELECT department_read_grants()) ? (workspace_id)::text))
);

COMMIT;
