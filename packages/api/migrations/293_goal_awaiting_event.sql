-- 293_goal_awaiting_event.sql
--
-- The acting loop's `until:event` resume (docs/plans/task-goal-seeker.md §4.11).
-- When a goal's agent calls the `waitForEvent` tool mid-iteration, the goal
-- parks DURABLY here instead of polling: `{ "subscriptions": EventSubscription[],
-- "state": GoalLoopState }`. `subscriptions` is what the workflow event
-- dispatcher matches (the second-subscriber seam in workflow/event-trigger.ts) to
-- resume the goal when a matching connector / channel / page event arrives;
-- `state` carries the loop-state handoff (iteration / spend / no-progress streak /
-- in-flight run id) so the budget counters survive the wait. A far-out
-- safety-net goal-tick is the backstop if the event never comes. NULL = the goal
-- is not parked on an event.

BEGIN;

ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS awaiting_event jsonb;

COMMENT ON COLUMN public.goals.awaiting_event IS
  'Event-park marker while the acting loop waits on an external event (until:event, task-goal-seeker.md §4.11): { subscriptions: EventSubscription[], state: GoalLoopState }. The event dispatcher matches subscriptions to resume the goal; state preserves the budget counters across the wait. NULL = not parked.';

COMMIT;
