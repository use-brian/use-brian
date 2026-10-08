-- Retain the original review; a missing/deleted source cannot authorize use.
BEGIN;
ALTER TABLE browser_skill_grants ADD COLUMN source_approval_id uuid
  REFERENCES pending_approvals(id) ON DELETE SET NULL;
CREATE INDEX browser_skill_grants_review_source ON browser_skill_grants(source_approval_id)
  WHERE source_approval_id IS NOT NULL;
COMMIT;
