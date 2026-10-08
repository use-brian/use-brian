-- [COMP:campaigns/dispatch] Recipient source floor captured at approval.
-- Spec: docs/architecture/features/native-campaigns-and-attribution.md, "Recipient source floor".
-- Additive; historical recipients stay NULL (unclassified) and are never backfilled
-- from today's contact labels.
BEGIN;

ALTER TABLE campaign_email_recipients
  ADD COLUMN IF NOT EXISTS scope_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS scope_sources jsonb;

ALTER TABLE campaign_email_recipients
  ADD CONSTRAINT campaign_email_recipients_scope_pair
  CHECK ((scope_snapshot IS NULL) = (scope_sources IS NULL));

COMMIT;
