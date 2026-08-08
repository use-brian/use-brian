-- Session turn lease: make `sessions.status` a lock that can heal itself.
--
-- The 2026-08-08 incident: a workspace room sat at `status='running'` for ~31
-- minutes with no turn in flight anywhere. Every member's Live card showed
-- "Working", every addressed message queued behind a lock nobody owned, and no
-- reply ever arrived.
--
-- `status` was a lock with no owner and no lease. The chat route claims it
-- (`claimRoomTurn`) and releases it in exactly two places: the happy path and
-- the catch. The handler's `finally` releases the confirmation resolver, the
-- doc-run presence entry and the mid-turn inbox, but never the status lock, so
-- any exit that reaches neither path pins the room permanently.
--
-- The backstop could not save it either, and that is the part this migration
-- exists for. `sweepStuckSessions` keyed staleness off `last_active_at`, but
-- `findSessionById` WRITES `last_active_at = now()` on every read. A client
-- watching the room therefore refreshed the staleness clock forever: the
-- 6-minute sweeper fired only once everybody stopped looking, ~31 minutes late.
-- A liveness clock that ordinary reads can refresh is not a liveness clock.
--
-- So liveness moves to its own column that ONLY the running turn writes:
--
--   turn_lease_token     WHO holds the lock. Every lease operation is guarded
--                        on it, so an orphaned turn that wakes up after its
--                        lock was reclaimed cannot heartbeat, cancel or
--                        release the SUCCESSOR's turn. Without this the
--                        recovery paths below would corrupt the very state
--                        they exist to repair.
--   turn_heartbeat_at    the process holding the lock is alive (20s tick).
--                        Deliberately NOT progress -- a turn suspended on a
--                        tool confirmation keeps heartbeating and must never
--                        be reclaimed. Progress is a client-side concern.
--   cancel_requested_at  a stop was requested. The heartbeat tick is one
--                        UPDATE ... RETURNING, so it writes liveness and reads
--                        cancellation in the same statement -- that is how a
--                        stop reaches a turn running in another process.
--   turn_end_reason      why the last turn ended (completed | stopped_by_user
--                        | stalled_reclaimed | timeout), so a heal can explain
--                        itself instead of a room silently unsticking.
--
-- `last_active_at` is untouched and stays what it always was: a read-touched
-- recency column driving rail ordering.
--
-- Spec: docs/architecture/context-engine/session-messages.md
--       -> "Turn lease and recovery".

BEGIN;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS turn_lease_token    UUID,
  ADD COLUMN IF NOT EXISTS turn_heartbeat_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS turn_end_reason     TEXT;

-- The sweeper scans only running rows, so the partial index keeps it cheap as
-- `sessions` grows. Rows written before this migration have a NULL heartbeat;
-- the sweep predicate coalesces to `last_active_at` for them.
CREATE INDEX IF NOT EXISTS idx_sessions_running_lease
  ON sessions (turn_heartbeat_at)
  WHERE status = 'running';

COMMIT;
