-- Per-member workspace-picker organization.
-- These fields are navigation preferences only: they never change workspace
-- membership, lifecycle, billing, or another member's picker.

BEGIN;

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS picker_pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS picker_hidden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS picker_last_opened_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS workspace_members_picker_preferences_idx
  ON workspace_members (
    user_id,
    picker_hidden_at,
    picker_pinned_at DESC,
    picker_last_opened_at DESC
  );

COMMENT ON COLUMN workspace_members.picker_pinned_at IS
  'Per-member navigation preference. Non-null places the workspace in Pinned.';
COMMENT ON COLUMN workspace_members.picker_hidden_at IS
  'Per-member navigation preference. Non-null hides the workspace only in scalable picker chrome.';
COMMENT ON COLUMN workspace_members.picker_last_opened_at IS
  'Per-member recency marker updated when the member opens the workspace.';

COMMIT;
