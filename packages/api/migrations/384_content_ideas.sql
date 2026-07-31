BEGIN;

-- Idea backlog: a raw, undated jot the operator captures the moment it
-- occurs, to be developed into a post later. Deliberately NOT a plan slot:
-- a slot is a dated, platform-targeted intent (feed-revamp.md D2), while an
-- idea has neither a date nor a platform yet.
--
-- No stored status column. An idea's state is derived at read time from what
-- it is bound to - `slot_id`/`session_id` set means promoted, `discarded_at`
-- set means discarded, otherwise open - the same no-drift rule plan slots
-- follow (feed-revamp.md D7). ON DELETE SET NULL on both links means deleting
-- the slot or session an idea became returns the idea to the open backlog
-- rather than silently losing it.
-- Spec: docs/architecture/feed/operator-app.md -> "Ideas backlog".
CREATE TABLE IF NOT EXISTS content_ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  text text NOT NULL,
  note text,
  -- Validated in the route against CONTENT_PLANNING_PLATFORMS, not a CHECK:
  -- the platform vocabulary lives in code and a copy here would drift the
  -- next time a platform is added (the content_plan_slots CHECK already has).
  platform_hint text,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'chat', 'inspiration', 'voice')),
  slot_id uuid REFERENCES content_plan_slots(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  discarded_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The backlog's only read pattern: one assistant, newest first.
CREATE INDEX IF NOT EXISTS content_ideas_assistant_created_idx
  ON content_ideas (assistant_id, created_at DESC);

ALTER TABLE content_ideas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_ideas_workspace_member ON content_ideas;
CREATE POLICY content_ideas_workspace_member
  ON content_ideas
  USING (
    EXISTS (
      SELECT 1
        FROM assistants a
        JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
       WHERE a.id = content_ideas.assistant_id
         AND wm.user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM assistants a
        JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
       WHERE a.id = content_ideas.assistant_id
         AND wm.user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

COMMIT;
