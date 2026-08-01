-- 390: sender_assistant_id on session_messages — multi-assistant rooms
-- (multiplayer chat P3/T9; docs/plans/multiplayer-chat.md).
--
-- In a room, `@AssistantName` picks WHICH workspace assistant answers that
-- turn, so "the assistant" is no longer a property of the session alone.
-- This column records the answering assistant per assistant row — the
-- assistant-side twin of `sender_user_id` (migration 101): the UI renders
-- per-reply avatars from it, and assembly labels foreign-assistant turns so
-- a model answering as one assistant never mistakes another's words for its
-- own. NULL for human rows and for assistant rows older than this migration
-- (treated as the session's bound assistant).
--
-- Plain uuid, no FK — same posture as sender_user_id: a deleted assistant
-- must not cascade or block history.

BEGIN;

ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS sender_assistant_id uuid;

COMMIT;
