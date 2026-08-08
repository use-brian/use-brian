-- 426_inbox_retention_and_dismissals.sql
-- Doc Inbox: age-out retention + per-item dismiss-on-read (open tables).
--
-- Two additions, both serving one idea: an Inbox row is not forever.
--
-- 1. workspaces.inbox_retention_days — how many days an item stays in the
--    Inbox. Default 30. NULL means "never prune" (keep the old behavior).
--    The window is applied as a READ-TIME FILTER, never a delete: raising the
--    setting brings older items back, and no comment thread or mention is ever
--    destroyed by a retention change. That is the whole reason this is a
--    window and not a cleanup job.
--
-- 2. doc_inbox_dismissals — the persisted "I have read this" record for the
--    DERIVED half of the Inbox. Pending assistant replies are computed live
--    from comment_threads + session_messages (there is no row to mark), so
--    clicking one has nothing to update. This table is that missing state,
--    keyed per RECIPIENT (not per thread) because the dismissal is a property
--    of the reader, not of the shared thread.
--
--    `dismissed_at` is compared against the thread's LATEST comment time, not
--    used as a boolean: a thread re-enters the Inbox when the assistant replies
--    AGAIN after the dismissal. Dismissing clears what you have seen; it does
--    not mute the thread. The thread itself is untouched and stays on its page.
--
-- Mentions need no table — they are already rows, and dismiss-on-read is
-- expressed there by filtering `read_at IS NULL` in the list query.
--
-- See docs/architecture/features/doc-inbox.md → "Retention" and
-- "Dismiss on read", and docs/architecture/platform/workspaces.md →
-- "Inbox retention".

BEGIN;

-- 1. Retention window. DEFAULT 30 backfills every existing workspace to the
-- new 30-day behavior (a metadata-only default in PG 11+). NULL is the
-- explicit "never prune" opt-out; the column is nullable for exactly that.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS inbox_retention_days INTEGER DEFAULT 30;

COMMENT ON COLUMN workspaces.inbox_retention_days IS
  'Doc Inbox retention window in days (migration 426). NULL = never prune. Applied as a read-time filter, never a delete.';

-- 2. Dismissals. PK (recipient_user_id, thread_id) is also the lookup index for
-- the pending-replies join, which reads one recipient's dismissals at a time.
-- thread_id CASCADEs: a deleted thread can never be pending, so its dismissal
-- is dead weight. workspace_id rides along so the workspace data-flush can
-- clear these directly rather than relying on the cascade ordering.
CREATE TABLE IF NOT EXISTS doc_inbox_dismissals (
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_user_id, thread_id)
);

COMMENT ON TABLE doc_inbox_dismissals IS
  'Doc Inbox dismiss-on-read for DERIVED pending assistant replies (migration 426). Compared against the thread''s latest comment time, so a new assistant reply re-surfaces the row.';

-- Recipient-scoped RLS, mirroring doc_notifications_recipient. Reads and writes
-- are both self-owned here (you dismiss your own row), so the single USING
-- expression is sufficient — Postgres reuses it as the INSERT WITH CHECK,
-- which is what stops a forged recipient id from minting someone else's
-- dismissal. No system-bypass policy: nothing writes these on another user's
-- behalf, unlike doc_notifications where the actor authors the recipient's row.
ALTER TABLE doc_inbox_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY doc_inbox_dismissals_recipient ON doc_inbox_dismissals
  USING (recipient_user_id = (current_setting('app.current_user_id', true))::uuid);

COMMIT;
