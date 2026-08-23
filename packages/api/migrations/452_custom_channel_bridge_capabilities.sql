-- 452: custom bridge declared capabilities.
--
-- A custom bridge reports what it can put on the wire (today: `documents`)
-- in its PUT /state payload. The route threads the stored answer into the
-- sendFile gate per turn, so file delivery unlocks only on bridges that
-- actually perform a file send for outbox `payload.documents` — an
-- undeclared bridge keeps refusing honestly instead of silently dropping.

BEGIN;

ALTER TABLE custom_channel_bridge_state
  ADD COLUMN IF NOT EXISTS capabilities JSONB;

COMMIT;
