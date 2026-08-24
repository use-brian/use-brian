-- 469: widen `doc_notifications` to also hold a ROOM mention (a human
-- `@Jane Doe` tag in workspace chat), not only a page/comment mention.
-- docs/plans/room-human-mentions.md (T-H3, D-H5).
--
-- Trap: migration 227 created this table as `canvas_notifications`;
-- migration 258 renamed the TABLE, its indexes, and its RLS policies to the
-- `doc_*` names, but never touched the column constraints -- every
-- constraint on this table (including the kind CHECK) is still named
-- `canvas_notifications_*`. `DROP CONSTRAINT doc_notifications_kind_check`
-- does not exist and will fail; the real name is
-- `canvas_notifications_kind_check` (verified directly against
-- packages/api/migrations/000_open_schema_v1.sql's `CREATE TABLE
-- public.doc_notifications` block).
--
-- D-H5: this widens the existing lane in place rather than adding a second
-- table -- one Inbox query, one panel, and the retention window / RLS policy
-- / GDPR erasure (db/workspace-flush.ts) all keep working untouched.
-- Carrying room rows under the `doc_` prefix is accepted debt (a rename is
-- explicitly out of scope, see the plan's D-H5).

BEGIN;

-- `page_id` was NOT NULL for the page/comment-mention shape; a room mention
-- has no page. `ALTER COLUMN ... DROP NOT NULL` is a no-op (not an error)
-- when already nullable, so this is safe to re-run, and it works regardless
-- of whether the underlying NOT NULL constraint carries its own catalog name
-- (`canvas_notifications_page_id_not_null` per the dump) -- DROP NOT NULL
-- targets the column, not that name.
ALTER TABLE doc_notifications
  ALTER COLUMN page_id DROP NOT NULL;

-- Room-mention target: the room the tag was posted in.
ALTER TABLE doc_notifications
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;

-- Room-mention anchor: the message row that carried the tag. Required (not
-- merely present) for a room_mention row -- D-H6's edit diff-reconcile
-- (retract-on-removal, re-surface-on-re-add) and T-H2's fan-out idempotency
-- both key on this column; `session_id` alone cannot express either.
ALTER TABLE doc_notifications
  ADD COLUMN IF NOT EXISTS session_message_id uuid REFERENCES session_messages(id) ON DELETE CASCADE;

-- Widen the kind CHECK to admit 'room_mention' beside 'mention'. Real name is
-- canvas_notifications_kind_check (see trap above); DROP ... IF EXISTS makes
-- this safe to re-run under either the pre- or post-migration state.
ALTER TABLE doc_notifications
  DROP CONSTRAINT IF EXISTS canvas_notifications_kind_check;

ALTER TABLE doc_notifications
  ADD CONSTRAINT canvas_notifications_kind_check
  CHECK (kind IN ('mention', 'room_mention'));

-- Exactly one target per row: a page/comment mention carries page_id and no
-- session_id; a room mention carries session_id and no page_id.
ALTER TABLE doc_notifications
  DROP CONSTRAINT IF EXISTS doc_notifications_target_xor_check;

ALTER TABLE doc_notifications
  ADD CONSTRAINT doc_notifications_target_xor_check
  CHECK (num_nonnulls(page_id, session_id) = 1);

-- Fan-out idempotency (T-H2/T-H6): `@Ops @Sales @Jane Doe` in a room sends
-- one POST per assistant target, but only the FIRST creates the user-message
-- row (roomResponseGroup.sourceMessageId); every writer that tries to record
-- Jane's mention for that message therefore lands on the SAME row per
-- (message, recipient) instead of inserting a duplicate. Also the mechanism
-- behind D-H6's "re-add a name whose row was already read": the recorder's
-- ON CONFLICT targets this index. Partial because only room_mention rows
-- carry a session_message_id.
CREATE UNIQUE INDEX IF NOT EXISTS doc_notifications_session_message_recipient_idx
  ON doc_notifications (session_message_id, recipient_user_id)
  WHERE session_message_id IS NOT NULL;

COMMENT ON COLUMN doc_notifications.session_id IS
  'Room-mention target (kind = room_mention): the session the @tag was posted in. NULL for page/comment mentions.';

COMMENT ON COLUMN doc_notifications.session_message_id IS
  'Room-mention anchor (kind = room_mention): the session_messages row that carried the @tag. Required for room mentions -- backs edit diff-reconcile (D-H6) and fan-out idempotency (T-H2) via the partial unique index above.';

COMMIT;
