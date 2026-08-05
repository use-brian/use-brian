-- 400_task_candidate_quality.sql
--
-- Grounded task-readiness audit. Automatic task generation now has a
-- separate readiness judgment before duplicate/rule admission. Candidates
-- that are not tasks, need more specification, or could not be verified need
-- distinct reason codes, and the Suggestions surface needs the structured
-- facts that explain the decision.
--
-- Spec: docs/architecture/features/task-guardrails.md

BEGIN;

ALTER TABLE task_candidates
  DROP CONSTRAINT IF EXISTS task_candidates_reason_code_check;

ALTER TABLE task_candidates
  ADD CONSTRAINT task_candidates_reason_code_check
  CHECK (reason_code IN (
    'tombstoned',
    'rule',
    'rule_requires',
    'duplicate',
    'near_duplicate',
    'not_a_task',
    'needs_spec',
    'quality_unverified'
  ));

ALTER TABLE task_candidates
  ADD COLUMN IF NOT EXISTS quality jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
