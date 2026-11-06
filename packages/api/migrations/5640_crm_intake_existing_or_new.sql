-- Intake identity policy `existing_or_new`: an unverified public submission
-- attaches to the one live contact that already holds its normalized email
-- and only fills that contact's empty fields; with no match it creates one.
-- It never overwrites a populated field, so a typed claim cannot rewrite
-- someone else's record, and a returning visitor no longer becomes a second
-- person that managed delivery then refuses as ambiguous.
-- [COMP:crm/operations-store]
BEGIN;
ALTER TABLE crm_intake_definition_versions
  DROP CONSTRAINT crm_intake_definition_versions_identity_policy_check;
ALTER TABLE crm_intake_definition_versions
  ADD CONSTRAINT crm_intake_definition_versions_identity_policy_check
  CHECK (identity_policy IN ('external_subject','trusted_verified_email','new_or_review','existing_or_new'));
COMMIT;
