-- WeChat (iLink) per-contact context tokens.
--
-- iLink issues a `context_token` on every inbound message; outbound sends to
-- that contact must echo the latest one. Sends happen API-side (the bridge is
-- inbound-only), including proactive/scheduled delivery long after the inbound
-- request, so the token must be durable — one row per (channel, contact),
-- overwritten on every inbound message. Internal-path table (webhook hot
-- path + delivery workers): no RLS, mirroring chat_turn_locks.
-- See docs/architecture/channels/wechat.md → "Context tokens".
BEGIN;

CREATE TABLE IF NOT EXISTS wechat_context_tokens (
  channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  ilink_user_id  TEXT NOT NULL,
  context_token  TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, ilink_user_id)
);

COMMIT;
