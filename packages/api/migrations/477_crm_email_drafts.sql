-- Canonical chat-authored email drafts, immutable revisions, and one active
-- draft anchor per conversation. These rows never carry provider/send authority.
-- Spec: docs/architecture/features/crm.md -> "Chat-authored drafts".

BEGIN;

CREATE TABLE crm_email_drafts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'discarded')),
  revision                INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  from_address            TEXT,
  to_addresses            TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses            TEXT[] NOT NULL DEFAULT '{}',
  bcc_addresses           TEXT[] NOT NULL DEFAULT '{}',
  subject                 TEXT NOT NULL DEFAULT '',
  body                    TEXT NOT NULL CHECK (length(body) > 0),
  created_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  source_session_id       UUID REFERENCES sessions(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX crm_email_drafts_workspace_updated
  ON crm_email_drafts (workspace_id, updated_at DESC, id DESC)
  WHERE status = 'draft';

CREATE TABLE crm_email_draft_versions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_id                UUID NOT NULL,
  revision                INTEGER NOT NULL CHECK (revision > 0),
  from_address            TEXT,
  to_addresses            TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses            TEXT[] NOT NULL DEFAULT '{}',
  bcc_addresses           TEXT[] NOT NULL DEFAULT '{}',
  subject                 TEXT NOT NULL DEFAULT '',
  body                    TEXT NOT NULL CHECK (length(body) > 0),
  created_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  source_session_id       UUID REFERENCES sessions(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draft_id, revision),
  FOREIGN KEY (workspace_id, draft_id)
    REFERENCES crm_email_drafts(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX crm_email_draft_versions_history
  ON crm_email_draft_versions (workspace_id, draft_id, revision DESC);

CREATE TABLE crm_email_draft_session_anchors (
  session_id   UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_id     UUID NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, draft_id)
    REFERENCES crm_email_drafts(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX crm_email_draft_session_anchors_draft
  ON crm_email_draft_session_anchors (workspace_id, draft_id, updated_at DESC);

ALTER TABLE crm_email_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_email_draft_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_email_draft_session_anchors ENABLE ROW LEVEL SECURITY;

CREATE POLICY crm_email_drafts_member ON crm_email_drafts
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY crm_email_draft_versions_member ON crm_email_draft_versions
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY crm_email_draft_session_anchors_member ON crm_email_draft_session_anchors
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid));

CREATE POLICY crm_email_drafts_system ON crm_email_drafts
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');
CREATE POLICY crm_email_draft_versions_system ON crm_email_draft_versions
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');
CREATE POLICY crm_email_draft_session_anchors_system ON crm_email_draft_session_anchors
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

COMMIT;
