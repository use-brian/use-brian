-- [COMP:api/session-turn-reconnect] Stable elapsed time across chat re-entry.
-- Leave existing turns unknown: heartbeat/recency timestamps are not starts.
BEGIN;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_started_at TIMESTAMPTZ;
COMMIT;
