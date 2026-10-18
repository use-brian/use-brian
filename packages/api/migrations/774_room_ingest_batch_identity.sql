-- Room ambient capture has a session parent, not a connector ingest rule.
BEGIN;

ALTER TABLE pending_ingest_batches
  ALTER COLUMN rule_id DROP NOT NULL,
  ADD COLUMN room_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;

-- Older installations without the connector FK may already contain room
-- batches using the session id in rule_id. Preserve only valid identities;
-- the constraint below rejects unidentified rows rather than dropping them.
UPDATE pending_ingest_batches b
   SET room_session_id = s.id, rule_id = NULL
  FROM sessions s
 WHERE b.source = 'room' AND b.rule_id = s.id AND b.workspace_id = s.workspace_id;

ALTER TABLE pending_ingest_batches ADD CONSTRAINT pending_ingest_batch_parent CHECK (
  (source = 'room' AND room_session_id IS NOT NULL AND rule_id IS NULL)
  OR (source <> 'room' AND rule_id IS NOT NULL AND room_session_id IS NULL)
);

-- Existing valid duplicate windows are preserved and drained independently.
-- New producers serialize on the session parent before finding/appending.
CREATE INDEX pending_room_batch_pool_key
  ON pending_ingest_batches (room_session_id, fires_at, scope_binding_origin, scope_held)
  WHERE source = 'room' AND processed_at IS NULL;

COMMIT;
