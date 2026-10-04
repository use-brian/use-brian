-- Migration 606 rebuilt office_audit_member around office_artifact_scope_allows(artifact_id,...)
-- to add the PDF-session owner/expiry gate. Template lifecycle audit rows carry
-- artifact_id NULL and a typed metadata.templateId, so that predicate is false for
-- every one of them: the permissive policy stopped admitting template lifecycle
-- audit (INSERT and SELECT) while the 596/597 RESTRICTIVE policies still resolve
-- the typed template identity. Reuse the same typed adapter here; artifact rows
-- still delegate to office_artifact_scope_allows, so the session gate is kept.
-- [COMP:api/office-access]
BEGIN;
DROP POLICY IF EXISTS office_audit_member ON office_audit_events;
CREATE POLICY office_audit_member ON office_audit_events USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
  AND office_audit_scope_allows(artifact_id,workspace_id,metadata,false)
);
COMMIT;
