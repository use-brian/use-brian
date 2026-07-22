-- 364_ingest_external_sink.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- External-sink destination class for the ingest pipeline
-- (docs/architecture/brain/ingest-external-sink.md; plan
-- docs/plans/ingestion-external-endpoint.md). A sink attaches to a
-- connector_instance (the same attachment point as ingest_rules) and receives
-- the instance's normalized events under the versioned `ub.ingest.append.v1`
-- contract via a TRANSACTIONAL OUTBOX + relay worker — never a synchronous
-- inline POST (messaging-archive D8). The record + outbox row commit in one
-- local transaction with the event capture (D10); the sink cursor advances
-- only on a 200 ack carrying `ack_cursor` (X3).
--
-- Sink secrets are AES-256-GCM blobs under CHANNEL_CREDENTIAL_KEY
-- (credential-crypto.ts — the house connector-credential pattern; never
-- inline plaintext, X6). No provider knowledge lives here (X1): `source` on
-- the outbox row is a label for the wire payload, and the cursor is opaque.

BEGIN;

CREATE TABLE ingest_external_sink (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_instance_id UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint_url          TEXT NOT NULL,
  auth_kind             TEXT NOT NULL CHECK (auth_kind IN ('bearer', 'hmac')),
  -- AES-256-GCM blob (iv ‖ tag ‖ ciphertext) of { secret } under
  -- CHANNEL_CREDENTIAL_KEY. Never plaintext.
  secret_ciphertext     BYTEA,
  -- 'all' = archive-always (every normalized event, the default);
  -- 'rule_filtered' = only events whose ingest_rules decision matched
  -- (and was not 'drop').
  mode                  TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'rule_filtered')),
  enabled               BOOLEAN NOT NULL DEFAULT true,
  -- Last cursor the sink durably acked (opaque, echoed by the sink on 200).
  -- Advances ONLY on ack — this is the X3 barrier.
  last_ack_cursor       JSONB,
  last_delivered_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ingest_external_sink_instance
  ON ingest_external_sink (connector_instance_id);

CREATE TABLE ingest_outbox (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sink_id               UUID NOT NULL REFERENCES ingest_external_sink(id) ON DELETE CASCADE,
  connector_instance_id UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Compartment owner for person-scoped consumers (archive is person-scoped,
  -- messaging-archive D3). Nullable — not every source is person-scoped.
  owner_user_id         UUID,
  source                TEXT NOT NULL,
  -- Whole-batch idempotency key, sent as X-UB-Idempotency-Key. Stable across
  -- retries of the same row, so the sink can collapse whole-batch replays.
  batch_id              UUID NOT NULL DEFAULT gen_random_uuid(),
  -- Canonical message records (the ub.ingest.append.v1 `messages` array).
  messages              JSONB NOT NULL,
  -- Opaque producer cursor, echoed to the sink and back on ack.
  source_cursor         JSONB,
  -- 'dead' = dead-lettered on a non-429 4xx (schema rejection, X7) — kept
  -- visible for admin triage, never silently dropped. 429/5xx NEVER
  -- dead-letter: the stream is irreplaceable, so retries are unbounded
  -- with capped backoff.
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error            TEXT,
  locked_by             TEXT,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at          TIMESTAMPTZ
);

CREATE INDEX idx_ingest_outbox_due
  ON ingest_outbox (status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_ingest_outbox_sink
  ON ingest_outbox (sink_id, created_at);
CREATE INDEX idx_ingest_outbox_dead
  ON ingest_outbox (created_at DESC) WHERE status = 'dead';

-- Worker/system-only state (the pending_ingest_batches posture): access goes
-- through system stores on the owner pool; control-plane routes do their own
-- RLS-gated connector_instance access check first.
ALTER TABLE ingest_external_sink ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_external_sink_system ON ingest_external_sink
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

ALTER TABLE ingest_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_outbox_system ON ingest_outbox
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

COMMIT;
