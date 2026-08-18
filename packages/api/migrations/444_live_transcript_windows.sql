-- Live meeting capture: provisional transcript windows move OUT of doc blocks
-- into their own table, rendered by a dedicated page surface (the live
-- transcript pane) instead of raw page text. Each row is one ~30s rolling
-- recorder window: its transcript lines (with best-effort per-window speaker
-- labels), its offset in the capture, and - when the byte persist succeeded -
-- the storage key of the window's audio, which the finalize fallback can
-- assemble into a usable recording when the lossless full upload fails.
--
-- Rows are small (text only; audio lives in object storage) and die with
-- their page (ON DELETE CASCADE). Access is route-gated by workspace
-- membership; the store reads through the owner pool.

BEGIN;

CREATE TABLE IF NOT EXISTS live_transcript_windows (
  chunk_id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id UUID REFERENCES saved_views(id) ON DELETE CASCADE,
  offset_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  -- Consecutive windows that failed client-side immediately before this one -
  -- rendered as a visible gap marker so a hole never reads as silence.
  missed_before INTEGER NOT NULL DEFAULT 0,
  -- [{"speaker": "Speaker 1" | null, "text": "..."}]
  lines JSONB NOT NULL DEFAULT '[]',
  -- Storage key of the persisted window audio (NULL when the best-effort
  -- persist failed); cleared again when finalize assembles + deletes them.
  audio_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_transcript_windows_page_idx
  ON live_transcript_windows (page_id, offset_ms);
CREATE INDEX IF NOT EXISTS live_transcript_windows_session_idx
  ON live_transcript_windows (session_id, offset_ms);

COMMIT;
