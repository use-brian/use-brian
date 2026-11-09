-- External requests are display-only. Human resolution remains in pending_approvals;
-- cancellation/applicability and relay receipts never overwrite human decision evidence.
BEGIN;
CREATE TABLE external_approval_requests (
  approval_id uuid PRIMARY KEY REFERENCES pending_approvals(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  source_binding text NOT NULL CHECK (source_binding ~ '^[a-f0-9]{64}$'),
  external_request_id text NOT NULL,
  task_id text NOT NULL,
  session_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  immutable_input jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  ack_status text CHECK (ack_status IN ('applied','stale','failed')),
  acknowledged_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_request_id)
);
CREATE INDEX external_approval_requests_expiry ON external_approval_requests(expires_at);
-- Only the system service accesses transport metadata; no tenant RLS projection.
ALTER TABLE external_approval_requests ENABLE ROW LEVEL SECURITY;
COMMIT;
