-- Channel rooms (unified-sessions S4, D4, D16).
--
-- A converged provider group is a workspace session anchored to the channel
-- (migration 741, anchor_kind='channel'). Three facts about it live on the row:
--
--   room_capture       D4: un-mentioned messages feed brain capture. A
--                      workspace admin can switch it off per room; the
--                      messages still persist as room context.
--   room_disclosed_at  D4: the one-time disclosure the assistant posts in the
--                      group when the room converges. Claimed atomically so
--                      it is posted once.
--   room_hydrated_at   D16: the room is hydrated once from provider-visible
--                      history. Claimed atomically.
--
-- And one fact about the per-user group sessions the room replaces:
--
--   archived_at        D16: a legacy per-user group session becomes read-only
--                      personal history for its owner. It is never merged into
--                      the room and never receives another turn.
--
-- Additive, no data change, no trigger functions.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN room_capture boolean NOT NULL DEFAULT true,
  ADD COLUMN room_disclosed_at timestamptz,
  ADD COLUMN room_hydrated_at timestamptz;

COMMIT;
