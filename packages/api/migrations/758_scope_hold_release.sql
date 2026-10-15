-- 758_scope_hold_release.sql  (OPEN table -> use-brian/packages/api/migrations/)
--
-- Scope review gains `release` for held memories
-- (docs/plans/scope-hold-recovery.md). A release never un-holds a row: it
-- re-derives a replacement from the held row's sources resolved to their
-- current heads, records fresh lineage, and retires the held row, which stays
-- held as history. The writer lives in the API
-- (workspace-access/hold-recovery.ts); this migration only admits the action
-- on the durable review job. Owner-role safe.

BEGIN;

ALTER TABLE workspace_scope_reviews DROP CONSTRAINT workspace_scope_reviews_action_check;
ALTER TABLE workspace_scope_reviews ADD CONSTRAINT workspace_scope_reviews_action_check
  CHECK(action IN('confirm_general','assign_team','consolidate_default','hold','release'));

-- Member review requests (`scope.hold.review_requested`) and the admin count
-- read the access timeline by kind.
CREATE INDEX workspace_access_events_kind ON workspace_access_events(workspace_id,kind,created_at DESC);

COMMIT;
