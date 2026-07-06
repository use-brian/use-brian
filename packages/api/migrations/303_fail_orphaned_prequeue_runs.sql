-- Retire orphaned pre-queue scheduled runs (2026-07-06 incident cleanup).
--
-- Scheduled runs advance INLINE via the poll worker and are only momentarily
-- status='pending' (the creation default) before advancing. A scheduled run
-- still 'pending'/'running' more than an hour after it started never advanced
-- inline — it is a crash/pre-migration orphan. Historically these sat inert.
--
-- The mig-302 run-queue drain worker then began claiming ANY pending row and
-- resurrected ~70 such 'schedule' orphans oldest-first, re-firing a user's
-- medication reminder in a storm. The code fix scopes the queue to
-- trigger_kind='manual' (the kind event dispatch stamps) so it can never claim
-- these again; this migration fails the already-orphaned population so the
-- in-flight storm stops immediately and the cruft is cleared.
--
-- Targets ONLY non-queue-owned ('schedule') runs stuck > 1h — never a
-- freshly-created run mid inline-advance, never a queue-owned 'manual' run
-- (the drainer owns those). Idempotent: re-running matches nothing (status is
-- now 'failed').
--
-- Spec: docs/architecture/features/workflow.md → "Event run queue" (Claiming:
-- queue-owned runs only). [COMP:workflow/run-queue]

BEGIN;

UPDATE workflow_runs
   SET status = 'failed',
       finished_at = now(),
       error = jsonb_build_object(
         'message', 'Orphaned pre-queue scheduled run retired by migration 303.',
         'reason', 'orphaned_pre_queue_run')
 WHERE status IN ('pending', 'running')
   AND trigger_kind = 'schedule'
   AND started_at < now() - interval '1 hour';

COMMIT;
