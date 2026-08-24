-- Durable idempotency claims for inbound messaging-channel events.
--
-- Connector transports may redeliver after reconnect or timeout. The API
-- claims `(channel_id, event_id)` before model work so a process restart cannot
-- produce a second reply. Rows expire after 14 days through the claim query's
-- bounded prune; provider message ids are not reused inside that window.
BEGIN;

CREATE TABLE IF NOT EXISTS public.channel_event_dedup (
  channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 512),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, event_id)
);

CREATE INDEX IF NOT EXISTS channel_event_dedup_received_idx
  ON public.channel_event_dedup (received_at);

-- Internal connector route only. Like chat_turn_locks, there is no end-user
-- query surface and therefore no RLS policy.

COMMIT;
