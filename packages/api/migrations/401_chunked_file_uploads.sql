-- Durable upload sessions for large Work Bench file pins.
-- Part bytes live under <workspace>/.uploads/<upload>/<part> until completion;
-- this row is the ownership, expiry, idempotency, and cleanup ledger.

BEGIN;

CREATE TABLE workspace_file_uploads (
  id                       UUID PRIMARY KEY,
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  acting_user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id             UUID REFERENCES assistants(id) ON DELETE SET NULL,
  file_id                  UUID NOT NULL UNIQUE,
  path                     TEXT NOT NULL,
  name                     TEXT NOT NULL,
  mime                     TEXT NOT NULL,
  size_bytes               BIGINT NOT NULL CHECK (size_bytes > 0),
  chunk_size_bytes         INT NOT NULL CHECK (chunk_size_bytes > 0),
  part_count               INT NOT NULL CHECK (part_count > 0),
  storage_uri              TEXT NOT NULL,
  quota_exempt             BOOLEAN NOT NULL DEFAULT false,
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'assembling', 'completed', 'aborted')),
  expires_at               TIMESTAMPTZ NOT NULL,
  completed_at             TIMESTAMPTZ,
  parts_deleted_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, id),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_workspace_file_uploads_expiry
  ON workspace_file_uploads (expires_at)
  WHERE status IN ('pending', 'assembling');

CREATE INDEX idx_workspace_file_uploads_part_cleanup
  ON workspace_file_uploads (completed_at)
  WHERE status = 'completed' AND parts_deleted_at IS NULL;

ALTER TABLE workspace_file_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_file_uploads_member ON workspace_file_uploads
  USING (
    acting_user_id = (current_setting('app.current_user_id'::text, true))::uuid
    AND workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = (current_setting('app.current_user_id'::text, true))::uuid
    )
  )
  WITH CHECK (
    acting_user_id = (current_setting('app.current_user_id'::text, true))::uuid
    AND workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = (current_setting('app.current_user_id'::text, true))::uuid
    )
  );

COMMIT;
