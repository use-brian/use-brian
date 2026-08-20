BEGIN;

ALTER TABLE workflow_runs
  ADD COLUMN webhook_idempotency_key TEXT,
  ADD COLUMN webhook_body_sha256 TEXT;

ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_webhook_idempotency_pair_check
    CHECK (
      (webhook_idempotency_key IS NULL AND webhook_body_sha256 IS NULL)
      OR (
        webhook_idempotency_key IS NOT NULL
        AND length(webhook_idempotency_key) BETWEEN 1 AND 200
        AND webhook_body_sha256 ~ '^[0-9a-f]{64}$'
      )
    );

CREATE UNIQUE INDEX idx_workflow_runs_webhook_idempotency
  ON workflow_runs (workflow_id, webhook_idempotency_key)
  WHERE webhook_idempotency_key IS NOT NULL;

COMMIT;
