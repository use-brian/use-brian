-- CRM typed adaptability: permit one access-scoped CRM entity reference as a
-- bounded custom-field value. Allowed target kinds remain in the definition's
-- existing JSON options array and are validated at the application boundary.

BEGIN;

ALTER TABLE crm_field_definitions
  DROP CONSTRAINT IF EXISTS crm_field_definitions_field_type_check;

ALTER TABLE crm_field_definitions
  ADD CONSTRAINT crm_field_definitions_field_type_check
  CHECK (field_type IN (
    'text', 'number', 'date', 'boolean', 'single_select', 'multi_select',
    'entity_reference'
  ));

COMMIT;
