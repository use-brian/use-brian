-- Office collaboration spine: persisted Yjs state, semantic/spatial
-- discussion, suggestions, and single-flight indexes. See
-- docs/architecture/features/office.md.

BEGIN;

CREATE TABLE office_collab_documents (
  artifact_id           UUID PRIMARY KEY REFERENCES office_artifacts(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ydoc                  BYTEA NOT NULL,
  state_vector          BYTEA NOT NULL,
  canonical_hash        TEXT NOT NULL CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
  base_version          BIGINT NOT NULL CHECK (base_version >= 0),
  seq                   BIGINT NOT NULL DEFAULT 1 CHECK (seq > 0),
  lease_token           UUID,
  lease_expires_at      TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE office_comment_threads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_version_id   UUID NOT NULL REFERENCES office_artifact_versions(id) ON DELETE CASCADE,
  anchor_kind           TEXT NOT NULL CHECK (anchor_kind IN ('text_range','block','table_cell','slide','object','chart_datum','note_range','point','region')),
  anchor                JSONB NOT NULL,
  geometry              JSONB,
  target_snapshot_file_id UUID REFERENCES workspace_files(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','detached')),
  assigned_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_brian     BOOLEAN NOT NULL DEFAULT FALSE,
  due_at                TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  notification_mode     TEXT NOT NULL DEFAULT 'all' CHECK (notification_mode IN ('all','mentions','none')),
  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resolved_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at           TIMESTAMPTZ,
  detached_at           TIMESTAMPTZ,
  last_valid_version_id UUID REFERENCES office_artifact_versions(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE office_comment_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id             UUID NOT NULL REFERENCES office_comment_threads(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_type           TEXT NOT NULL CHECK (author_type IN ('user','assistant','system')),
  author_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  author_assistant_id   UUID REFERENCES assistants(id) ON DELETE SET NULL,
  body                  TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  mentions              UUID[] NOT NULL DEFAULT '{}',
  reactions             JSONB NOT NULL DEFAULT '{}',
  brian_trigger_key     TEXT,
  brian_run_status      TEXT CHECK (brian_run_status IN ('queued','working','needs_input','applied','proposed','failed','cancelled')),
  edited_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, brian_trigger_key)
);

CREATE TABLE office_suggestions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id             UUID REFERENCES office_comment_threads(id) ON DELETE SET NULL,
  base_version_id       UUID NOT NULL REFERENCES office_artifact_versions(id) ON DELETE CASCADE,
  proposed_by_type      TEXT NOT NULL CHECK (proposed_by_type IN ('user','assistant')),
  proposed_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  proposed_by_assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  command_batch         JSONB NOT NULL,
  affected_object_ids   UUID[] NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected','superseded','conflicted')),
  decided_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_office_collab_lease
  ON office_collab_documents (lease_expires_at) WHERE lease_token IS NOT NULL;
CREATE INDEX idx_office_comments_artifact_status
  ON office_comment_threads (artifact_id, status, created_at DESC);
CREATE INDEX idx_office_comments_assignment
  ON office_comment_threads (assigned_user_id, due_at) WHERE status = 'open';
CREATE INDEX idx_office_comment_messages_thread
  ON office_comment_messages (thread_id, created_at);
CREATE INDEX idx_office_suggestions_artifact_status
  ON office_suggestions (artifact_id, status, created_at DESC);
CREATE UNIQUE INDEX idx_office_suggestions_single_brian_thread
  ON office_suggestions (thread_id) WHERE thread_id IS NOT NULL AND status IN ('open','conflicted');

ALTER TABLE office_collab_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_comment_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_comment_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY office_collab_member ON office_collab_documents
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_comment_threads_member ON office_comment_threads
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_comment_messages_member ON office_comment_messages
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_suggestions_member ON office_suggestions
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));

COMMIT;
