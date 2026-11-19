-- [COMP:api/member-operation-floor] Per-statement member floor for engineering history updates.
-- 760 wrote engineering_history_file_update with the per-row member_operation_scope_allows
-- call that 615 retired. Same decision, grants resolved once per statement.
BEGIN;
DO $authenticate$
DECLARE p pg_policy; expected text;
BEGIN
 SELECT * INTO p FROM pg_policy WHERE polrelid='public.programmatic_archive_events'::regclass AND polname='engineering_history_file_update';
 expected:=$expr$(file_id IN ( SELECT workspace_files.id
   FROM workspace_files
  WHERE ((workspace_files.purpose = 'engineering_archive'::text) AND (workspace_files.valid_to IS NULL) AND (workspace_files.retracted_at IS NULL) AND (NOT workspace_files.scope_held) AND member_operation_scope_allows(workspace_files.workspace_id, workspace_files.sensitivity, workspace_files.compartments, true))))$expr$;
 IF p.polname IS NULL OR p.polcmd<>'w' OR NOT p.polpermissive OR p.polroles<>ARRAY[0::oid]
  OR pg_get_expr(p.polqual,p.polrelid) IS DISTINCT FROM expected
  OR pg_get_expr(p.polwithcheck,p.polrelid) IS DISTINCT FROM expected
 THEN RAISE EXCEPTION 'engineering_history_update_floor_predecessor_changed'; END IF;
END $authenticate$;
ALTER POLICY engineering_history_file_update ON public.programmatic_archive_events USING (
 file_id IN (SELECT id FROM public.workspace_files WHERE purpose='engineering_archive' AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
  AND public.member_operation_row_allows((SELECT public.member_operation_grants(true)),workspace_id,sensitivity,compartments))
) WITH CHECK (
 file_id IN (SELECT id FROM public.workspace_files WHERE purpose='engineering_archive' AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
  AND public.member_operation_row_allows((SELECT public.member_operation_grants(true)),workspace_id,sensitivity,compartments))
);
COMMIT;
