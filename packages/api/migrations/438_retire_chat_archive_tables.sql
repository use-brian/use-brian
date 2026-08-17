-- 438_retire_chat_archive_tables.sql
--
-- Numbered 438, not 3946. Migrations from every source dir are ordered by a
-- single LEXICOGRAPHIC sort of the filename (scripts/migration-order.ts), not
-- numerically — so "3946_" sorts before "405_" and this would have dropped the
-- tables *before* 405-409 created them. The highest-sorting migration is what
-- matters, not the highest number.
--
-- The chat archive moved to its own database inside `brian-message-store`.
--
-- Sharing one database made every platform migration a potential runtime break
-- for a service on a different release cadence — on-premise the archive commonly
-- lags the platform by weeks — and it left two writers on one schema with no
-- owner. The archive now owns its schema outright and the platform reaches it
-- only through versioned HTTP contracts (/append, /media, /search,
-- /enrichment/*, /channels).
--
-- MIGRATING AN EXISTING DEPLOYMENT
--
-- These tables hold personal message history that cannot be re-fetched from the
-- providers. Copy them into the archive's database BEFORE applying this
-- migration; there is no way to recover them afterwards. A dump of the seven
-- tables below restores directly, since the archive's schema keeps the same
-- table and column names — only the foreign keys to workspaces / connector
-- instance / users are dropped, because PostgreSQL cannot reference across
-- databases.
--
--   pg_dump --data-only \
--     -t chat_archive_messages -t chat_archive_segments \
--     -t chat_archive_media_assets -t chat_archive_coverage_windows \
--     -t chat_archive_backfill_runs -t chat_archive_enrichment_windows \
--     -t chat_archive_enrichment_messages \
--     "$PLATFORM_DATABASE_URL" | psql "$MESSAGE_STORE_DATABASE_URL"
--
-- Attachment bytes must move too: they lived in the platform's file backend and
-- now live in the archive's content-addressed blob directory.

BEGIN;

-- The deletion trigger references the assets table, so it goes first.
DROP TRIGGER IF EXISTS chat_archive_media_assets_queue_delete ON chat_archive_media_assets;
DROP FUNCTION IF EXISTS queue_chat_archive_media_deletion();

-- Ordered children-first for readability; CASCADE covers the rest.
DROP TABLE IF EXISTS chat_archive_enrichment_messages CASCADE;
DROP TABLE IF EXISTS chat_archive_enrichment_windows CASCADE;
DROP TABLE IF EXISTS chat_archive_media_deletions CASCADE;
DROP TABLE IF EXISTS chat_archive_media_jobs CASCADE;
DROP TABLE IF EXISTS chat_archive_media_assets CASCADE;
DROP TABLE IF EXISTS chat_archive_segments CASCADE;
DROP TABLE IF EXISTS chat_archive_coverage_windows CASCADE;
DROP TABLE IF EXISTS chat_archive_backfill_runs CASCADE;
DROP TABLE IF EXISTS chat_archive_messages CASCADE;

COMMIT;
