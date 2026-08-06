-- Admit the third Office artifact family. [COMP:api/office-store]
BEGIN;

ALTER TABLE office_artifacts
  DROP CONSTRAINT IF EXISTS office_artifacts_family_check;
ALTER TABLE office_artifacts
  ADD CONSTRAINT office_artifacts_family_check
  CHECK (family IN ('document', 'presentation', 'spreadsheet'));

ALTER TABLE office_templates
  DROP CONSTRAINT IF EXISTS office_templates_family_check;
ALTER TABLE office_templates
  ADD CONSTRAINT office_templates_family_check
  CHECK (family IN ('document', 'presentation', 'spreadsheet'));

COMMIT;
