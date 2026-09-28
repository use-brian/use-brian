BEGIN;

-- Attended authoring consent for work that can execute after the originating
-- turn ends. Existing rows stay NULL: historical authority cannot be inferred.
ALTER TABLE workflows ADD COLUMN authoring_authority jsonb;
ALTER TABLE goals ADD COLUMN authoring_authority jsonb;

ALTER TABLE workflows ADD CONSTRAINT workflows_authoring_authority_object
  CHECK (authoring_authority IS NULL OR jsonb_typeof(authoring_authority) = 'object');
ALTER TABLE goals ADD CONSTRAINT goals_authoring_authority_object
  CHECK (authoring_authority IS NULL OR jsonb_typeof(authoring_authority) = 'object');

COMMIT;
