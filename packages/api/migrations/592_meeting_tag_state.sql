-- Opt-in meeting tags and explicit rules. No seeded tags or rules.
BEGIN;
CREATE TABLE meeting_tag_state (
  page_id UUID PRIMARY KEY REFERENCES saved_views(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{"tags":[],"suppressed":[],"rules":[],"dismissed":[]}',
  version INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE meeting_tag_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_tag_page_access ON meeting_tag_state
  USING (EXISTS (SELECT 1 FROM saved_views WHERE id = meeting_tag_state.page_id))
  WITH CHECK (EXISTS (SELECT 1 FROM saved_views WHERE id = meeting_tag_state.page_id));
COMMIT;
