-- 372_assistant_chat_links.sql
--
-- Public chat link — hosted anonymous chat URL for an assistant.
-- Spec: docs/architecture/features/public-chat-link.md.
--
-- The token is stored RAW (not hashed) — a deliberate divergence from
-- page_grants. A chat-link URL is public-by-intent (the owner posts it
-- openly), re-showing it in the owner UI is core UX, and the blast radius
-- of a DB-read leak is bounded by revocation + the daily cap + the public
-- clearance floor. API keys stay hashed because they are private
-- credentials with real authority.
--
-- daily_used / daily_window_date implement an atomic fixed-window daily
-- counter: one UPDATE increments-or-resets by comparing the stored window
-- date to current_date, so concurrent turns never race a separate read.

BEGIN;

CREATE TABLE assistant_chat_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'Public chat',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  daily_message_limit integer NOT NULL DEFAULT 200 CHECK (daily_message_limit >= 0),
  daily_used integer NOT NULL DEFAULT 0,
  daily_window_date date NOT NULL DEFAULT CURRENT_DATE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

CREATE INDEX idx_chat_links_assistant ON assistant_chat_links (assistant_id, created_at DESC);

COMMIT;
