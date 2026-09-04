-- Brain-file attachment refs are part of every canonical CRM email-draft
-- revision. They remain references until a provider send tool resolves bytes
-- under its ordinary access, size, policy, and confirmation gates.
-- Spec: docs/architecture/features/crm.md -> "Chat-authored drafts".

BEGIN;

ALTER TABLE crm_email_drafts
  ADD COLUMN attachment_refs TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT crm_email_drafts_attachment_refs_limit
    CHECK (cardinality(attachment_refs) <= 10);

ALTER TABLE crm_email_draft_versions
  ADD COLUMN attachment_refs TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT crm_email_draft_versions_attachment_refs_limit
    CHECK (cardinality(attachment_refs) <= 10);

COMMIT;
