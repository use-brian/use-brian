-- Custom channel bridge tables (docs/architecture/channels/custom-channel.md).
--
-- A custom channel is driven by an operator-run bridge process that talks to
-- the API over a token-authenticated HTTP protocol: it publishes its state
-- (connecting / needs_action / connected / ...) and pulls outbound work from a
-- DB-backed outbox. Both tables are internal-path (no RLS): they are keyed by
-- channel and reachable only through the bridge token or the workspace
-- member routes, like wechat_context_tokens (migration 362).
BEGIN;

CREATE TABLE IF NOT EXISTS custom_channel_bridge_state (
  channel_id     UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'connecting',
  message        TEXT,
  account_label  TEXT,
  action         JSONB,
  bridge_version TEXT,
  last_seen_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custom_channel_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id          UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  peer_id             TEXT,
  item_type           TEXT NOT NULL,             -- message | typing | input | disconnect
  payload             JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_until        TIMESTAMPTZ,
  acked_at            TIMESTAMPTZ,
  ok                  BOOLEAN,
  error               TEXT,
  provider_message_id TEXT,
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS custom_channel_outbox_claim_idx
  ON custom_channel_outbox (channel_id, created_at)
  WHERE acked_at IS NULL;

COMMIT;
