-- Extend native frozen application, never scan or create duplicate work.
-- [COMP:api/crm-delivery-oversight]
-- Spec: docs/architecture/brain/ingest-pipeline.md -> Delivery agreement recognition
BEGIN;
ALTER TABLE episode_extraction_items DROP CONSTRAINT episode_extraction_items_primitive_kind_check;
ALTER TABLE episode_extraction_items ADD CONSTRAINT episode_extraction_items_primitive_kind_check CHECK(primitive_kind IN(
 'entity','edge','task','memory','ephemeral','episode_finalization','digest_memory','digest_edge','delivery_commitment'));
COMMIT;
