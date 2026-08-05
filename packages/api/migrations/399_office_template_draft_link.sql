-- Persist the editable artifact owned by a scratch-authored Office template.
-- Legacy backfill is deliberately conservative: ambiguous pairs remain NULL
-- and can never be initialized by the linked-draft recovery route.

BEGIN;

ALTER TABLE office_templates
  ADD COLUMN draft_artifact_id UUID REFERENCES office_artifacts(id) ON DELETE SET NULL;

WITH candidates AS (
  SELECT
    t.id AS template_id,
    a.id AS artifact_id,
    count(*) OVER (PARTITION BY t.id) AS template_matches,
    count(*) OVER (PARTITION BY a.id) AS artifact_matches
  FROM office_templates t
  JOIN office_artifacts a
    ON a.workspace_id = t.workspace_id
   AND a.owner_user_id = t.owner_user_id
   AND a.family = t.family
   AND a.mode = 'template'
   AND a.title = t.name
   AND abs(extract(epoch FROM (a.created_at - t.created_at))) < 10
  WHERE t.draft_artifact_id IS NULL
)
UPDATE office_templates t
   SET draft_artifact_id = c.artifact_id,
       updated_at = now()
  FROM candidates c
 WHERE t.id = c.template_id
   AND c.template_matches = 1
   AND c.artifact_matches = 1;

CREATE UNIQUE INDEX idx_office_templates_draft_artifact
  ON office_templates (draft_artifact_id)
  WHERE draft_artifact_id IS NOT NULL;

COMMIT;
