BEGIN;

-- Draft intent used to live in the hosted distribution overlay. Content
-- planning is open-core now, so every edition needs the discriminator.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS seed_kind text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'sessions_seed_kind_check'
       AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_seed_kind_check
      CHECK (
        seed_kind IS NULL
        OR seed_kind IN (
          'inspiration-reply',
          'inspiration-original',
          'freeform',
          'freeform-reply'
        )
      );
  END IF;
END
$$;

-- Canonical, provider-independent planning state. Hosted delivery/audit rows
-- may reference these records, but no platform account or credential is
-- required to create or resolve one manually.
CREATE TABLE IF NOT EXISTS content_planning_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram', 'threads', 'twitter', 'xhs')),
  draft_text text NOT NULL,
  final_text text,
  image_brief text,
  topic_tag text,
  reply_external_id text,
  reply_author text,
  reply_text text,
  reply_permalink text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'posted', 'rejected')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  posted_permalink text,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_planning_drafts_assistant_status_idx
  ON content_planning_drafts (assistant_id, status, created_at DESC)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS content_planning_drafts_session_idx
  ON content_planning_drafts (session_id, created_at DESC)
  WHERE removed_at IS NULL;

ALTER TABLE content_planning_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_planning_drafts_workspace_member
  ON content_planning_drafts;
CREATE POLICY content_planning_drafts_workspace_member
  ON content_planning_drafts
  USING (
    EXISTS (
      SELECT 1
        FROM assistants a
        JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
       WHERE a.id = content_planning_drafts.assistant_id
         AND wm.user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM assistants a
        JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
       WHERE a.id = content_planning_drafts.assistant_id
         AND wm.user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

COMMIT;
