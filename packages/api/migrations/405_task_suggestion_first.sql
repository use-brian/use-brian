-- 405_task_suggestion_first.sql
--
-- Suggestion-first task creation. The extracted lane no longer auto-creates
-- by default: a candidate that passes the full anti-slop floor holds as a
-- suggestion (reason_code='suggested') unless an active `allow` rule matches,
-- in which case the task is created and the auto-approval is recorded as an
-- audit case (status='auto_accepted', reason_code='auto_rule').
--
-- Spec: docs/architecture/features/task-guardrails.md
-- Plan: docs/plans/tasks-suggestion-first.md

BEGIN;

-- `allow` joins deny/require: an active allow rule is the workspace's explicit
-- opt-in to auto-creation for a matching class of ready candidates.
ALTER TABLE task_rules
  DROP CONSTRAINT IF EXISTS task_rules_effect_check;

ALTER TABLE task_rules
  ADD CONSTRAINT task_rules_effect_check
  CHECK (effect IN ('deny', 'require', 'allow'));

-- `auto_accepted` is the audit state for rule-driven auto-creation: the
-- candidate never waited in the tray, but the review view can still show
-- what the rule did (created_task_id + matched_rule_id are set).
ALTER TABLE task_candidates
  DROP CONSTRAINT IF EXISTS task_candidates_status_check;

ALTER TABLE task_candidates
  ADD CONSTRAINT task_candidates_status_check
  CHECK (status IN ('pending', 'accepted', 'dismissed', 'expired', 'dropped', 'auto_accepted'));

-- The channel ref (Slack channel id / connector ref) travels with the
-- candidate so "Always create tasks like this" can scope the allow rule to
-- the channel, not just the source kind. Admission already receives it
-- (TaskAdmissionCandidate.channelRef); it was simply not persisted.
ALTER TABLE task_candidates
  ADD COLUMN IF NOT EXISTS channel_ref text;

-- `suggested` = passed every check, held only because suggestion-first is the
-- default. `auto_rule` = created because an active allow rule matched.
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
    'quality_unverified',
    'suggested',
    'auto_rule'
  ));

COMMIT;
