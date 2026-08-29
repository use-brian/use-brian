-- Live roster hot query (docs/architecture/features/live-work.md §3.4):
-- `GET /api/workspaces/:id/live` reads running sessions on every roster
-- fetch and every spine-signal refetch. `status='running'` rows are a tiny
-- fraction of the table, so a partial index keeps the hot read
-- index-only-cheap; the recently-settled window rides the ordering column.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_sessions_running_last_active
  ON sessions (last_active_at)
  WHERE status = 'running';

COMMIT;
