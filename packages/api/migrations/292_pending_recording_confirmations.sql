-- 292_pending_recording_confirmations.sql
-- Channel recording pre-flight confirm (docs/plans/channel-recording-preflight-confirm.md §5).
--
-- A lookaside table for the hybrid pre-flight-confirm flow on the channel surface.
-- When a BIG (surcharge-incurring) recording is dropped into a chat channel, the
-- detached fire-and-forget intake does a cheap ffprobe (no transcription), inserts
-- a pending row here, and sends a templated ask. The user's reply (a normal channel
-- turn) is interpreted by the assistant, which calls `confirmRecordingProcessing`
-- to enqueue (or drop) via the existing `enqueueRecordingJob`.
--
-- Correlated by `channel_session_key = {channel}:{channel_id}:{acting_user_id}` so
-- the chat turn can look up "a recording awaits your confirmation" context. Keyed
-- by recording_id (the Episode) so the confirm tool validates against a real row;
-- ON DELETE CASCADE drops the pending row if the Episode is removed. Expired rows
-- (never answered) are swept by `deleteExpired()` and never spend (decision D4).

BEGIN;

CREATE TABLE pending_recording_confirmations (
  recording_id           UUID PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  channel_session_key    TEXT NOT NULL,
  duration_seconds       INT NOT NULL,
  surcharge_credits      INT NOT NULL,
  default_blueprint_slug TEXT,
  file_label             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL
);

CREATE INDEX pending_recording_confirmations_session_idx
  ON pending_recording_confirmations (channel_session_key);

CREATE INDEX pending_recording_confirmations_expires_idx
  ON pending_recording_confirmations (expires_at);

COMMIT;
