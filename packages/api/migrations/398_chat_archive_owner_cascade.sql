-- 398_chat_archive_owner_cascade.sql  (OPEN tables -> packages/api/migrations/)
-- Account deletion must remove every person-compartmented chat archive root.

BEGIN;

ALTER TABLE chat_archive_messages
  ADD CONSTRAINT chat_archive_messages_owner_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_archive_coverage_windows
  ADD CONSTRAINT chat_archive_coverage_owner_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_archive_backfill_runs
  ADD CONSTRAINT chat_archive_backfill_owner_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_archive_enrichment_windows
  ADD CONSTRAINT chat_archive_enrichment_owner_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;

COMMIT;
