-- Literal human answers are evidence, never executable approval payloads.
BEGIN;
ALTER TABLE external_approval_requests ADD COLUMN human_answer text;
COMMIT;
