-- Derived conversation rows inherit their sources' visibility. A NULL
-- assistant_id is a known workspace-wide audience, not missing scope evidence
-- (ResourceScope / deriveResourceScope). The session still owns the transcript;
-- its assistant identity and existing read policies are unchanged.
BEGIN;

ALTER TABLE session_messages DROP CONSTRAINT session_messages_scope_complete;
ALTER TABLE session_messages ADD CONSTRAINT session_messages_scope_complete CHECK (
  (workspace_id IS NULL AND user_id IS NULL AND assistant_id IS NULL
    AND sensitivity IS NULL AND compartments IS NULL AND project_ids IS NULL
    AND scope_version IS NULL AND scope_held IS NULL)
  OR
  (workspace_id IS NOT NULL
    AND sensitivity IS NOT NULL AND compartments IS NOT NULL AND project_ids IS NOT NULL
    AND scope_version IS NOT NULL AND scope_held IS NOT NULL)
);

COMMIT;
