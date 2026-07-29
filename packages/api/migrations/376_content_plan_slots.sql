BEGIN;

-- Marketing plan: a dated, platform-targeted intent that exists BEFORE any
-- copy does. Planning a month is the point, so a slot is valid with no draft
-- attached; `draft_id` binds it to the draft that eventually fills it.
--
-- `slot_status` deliberately holds ONLY the operator's own marks. The status
-- the API returns is derived at read time from the bound draft (or session),
-- so a slot and its draft can never drift out of sync.
-- Spec: docs/plans/feed-revamp.md §4/§5.
CREATE TABLE IF NOT EXISTS content_plan_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram', 'threads', 'twitter', 'xhs')),
  scheduled_for date NOT NULL,
  title text NOT NULL,
  brief text,
  slot_status text NOT NULL DEFAULT 'planned'
    CHECK (slot_status IN ('planned', 'skipped')),
  draft_id uuid REFERENCES content_planning_drafts(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The calendar's only read pattern: one assistant, one month.
CREATE INDEX IF NOT EXISTS content_plan_slots_assistant_date_idx
  ON content_plan_slots (assistant_id, scheduled_for);

ALTER TABLE content_plan_slots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_plan_slots_workspace_member ON content_plan_slots;
CREATE POLICY content_plan_slots_workspace_member
  ON content_plan_slots
  USING (
    EXISTS (
      SELECT 1
        FROM assistants a
        JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
       WHERE a.id = content_plan_slots.assistant_id
         AND wm.user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM assistants a
        JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
       WHERE a.id = content_plan_slots.assistant_id
         AND wm.user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

-- The month's goal, themes, and cadence: the artefact the operator and the
-- assistant iterate. Slots are its output, so a bag of dated chips is never
-- the whole plan. One row per assistant per month; `month_start` is always
-- the 1st (normalised by the store, pinned by the CHECK).
CREATE TABLE IF NOT EXISTS content_plan_briefs (
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  month_start date NOT NULL CHECK (date_trunc('month', month_start) = month_start),
  brief text NOT NULL DEFAULT '',
  themes text[] NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assistant_id, month_start)
);

ALTER TABLE content_plan_briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_plan_briefs_workspace_member ON content_plan_briefs;
CREATE POLICY content_plan_briefs_workspace_member
  ON content_plan_briefs
  USING (
    EXISTS (
      SELECT 1
        FROM assistants a
        JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
       WHERE a.id = content_plan_briefs.assistant_id
         AND wm.user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM assistants a
        JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
       WHERE a.id = content_plan_briefs.assistant_id
         AND wm.user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

COMMIT;
