-- 290_goal_completion_claim.sql
--
-- The agentic pivot (docs/plans/task-goal-seeker.md §12, Phase 3): the
-- verified-done marker for a `done_when: {kind:'verify'}` goal. When the agent
-- calls the `markGoalComplete` tool, the adversarial verifier judges the claim
-- against the goal's outcome; ONLY on a verifier pass is this column stamped
-- with `{ "because": <agent reason>, "verifiedAt": <iso> }`. The driver's
-- `verify` resolver reads it (verifiedDone = completion_claim IS NOT NULL), so a
-- verify goal reaches `done` only through a verifier pass (the §12 fail-safe
-- invariant). A refuted claim is NOT written — the refutation is fed back to the
-- agent in-session. NULL = no verified completion yet.

BEGIN;

ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS completion_claim jsonb;

COMMENT ON COLUMN public.goals.completion_claim IS
  'Agentic-termination verified-done marker (task-goal-seeker.md §12). Stamped { because, verifiedAt } ONLY when the adversarial verifier passes a markGoalComplete claim; the verify done_when leaf is met iff this is non-null. NULL = not yet verified-complete.';

COMMIT;
