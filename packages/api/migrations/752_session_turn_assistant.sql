-- 752: turn_assistant_id on sessions — the voice of the latest turn.
--
-- A doc-dock thread or a room re-addresses assistants per turn, so the
-- session's binding (`assistant_id`) is not who is answering. The Live
-- roster labelled every such turn with the binding: a turn sent to one
-- assistant showed under another's name while it ran. `startTurnLease`
-- stamps the answering assistant here when a turn takes the lease; it is
-- never cleared, so after the turn ends it still names the last voice.
-- NULL for sessions with no turn since this migration and for runners
-- that do not re-address (treated as the session's bound assistant).
--
-- Plain uuid, no FK — same posture as session_messages.sender_assistant_id
-- (migration 390): a deleted assistant must not cascade or block a session.

BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_assistant_id uuid;

COMMIT;
