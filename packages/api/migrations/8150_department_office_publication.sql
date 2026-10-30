BEGIN;
-- Extend the exact existing output contract, retaining every file/ACL check.
DO $$
DECLARE body text; needle text := $old$OR j.authority_projection->'creationBinding'->>'protocol' IS DISTINCT FROM 'office_prompt_only_v1'$old$;
BEGIN
 SELECT pg_get_functiondef('guard_office_generation_file_binding()'::regprocedure) INTO body;
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'office_publication_guard_contract_changed'; END IF;
 body:=replace(body,needle,$new$OR NOT (
   j.authority_projection->'creationBinding'->>'protocol'='office_prompt_only_v1'
   OR (j.authority_projection->'creationBinding'->>'protocol'='office_department_v2'
     AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=j.workspace_id AND w.department_read_v2)))
   OR j.authority_projection->'creationBinding'->>'actorUserId' IS DISTINCT FROM actor::text
   OR j.authority_projection->'creationBinding'->>'workspaceId' IS DISTINCT FROM j.workspace_id::text
   OR NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
     WHERE s.id::text=j.authority_projection->'creationBinding'->>'authSessionId'
       AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version)$new$);
 EXECUTE body;
END $$;
COMMIT;
