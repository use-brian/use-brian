-- Chat-turn lease rows: the row-based replacement for the session-level
-- pg_advisory_lock inside withChatLock (packages/api/src/db/chat-lock.ts).
--
-- A session advisory lock ties lock-hold to connection-hold, so every running
-- chat turn pinned a pool connection for its full duration. On the hosted
-- fleet (PG_POOL_MAX=2 per pool) a burst of concurrent turns left zero free
-- slots and the victim turn's first query died with "timeout exceeded when
-- trying to connect" (the 2026-07-14 Terry AI silent-Telegram incident) —
-- the same failure class withWorkerLock's row lease already fixed for worker
-- ticks (2026-05-25). This table is the chat-turn equivalent: acquire,
-- heartbeat, and release are each one fast statement; no connection is held
-- while the turn runs. Rows are transient (deleted on release, reclaimed by
-- expires_at takeover after a crash). System-pool access only, like
-- worker_locks — no RLS.
--
-- Spec: docs/architecture/channels/adapter-pattern.md → "Per-Chat
-- Sequentialization".

BEGIN;

CREATE TABLE chat_turn_locks (
    chat_key    text PRIMARY KEY,
    holder_id   uuid NOT NULL,
    expires_at  timestamp with time zone NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMIT;
