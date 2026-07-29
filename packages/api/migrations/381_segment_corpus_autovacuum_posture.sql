-- 381_segment_corpus_autovacuum_posture.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- B5v of docs/plans/corpus-substrate-hardening.md §5. Bounds the VACUUM debt
-- the embedding drain creates on the segment corpora.
--
-- The embed UPDATE writes `embedding`, which is HNSW-indexed, so the update
-- can never be HOT: every embedded row leaves a dead tuple behind. The
-- 2026-07-29 16:18 UTC autopsy (the first pg_stat_activity read either
-- incident allowed) found `email_archive_segments` at 118,940 embedded rows
-- carrying 214,697 dead tuples -- 40% of live. That tripped an autovacuum at
-- 03:43 UTC which was still running 12.5 hours later: heap scan (963 MB) done,
-- then index-vacuuming the HNSW + trgm GIN through a 128 MB shared_buffers,
-- wait state IO/DataFileRead throughout.
--
-- That IO starvation is what actually kept the fleet pinned at the 25-slot
-- ceiling for 8+ hours on 2026-07-29 WITH THE WORKERS PAUSED: not orphaned
-- backends (the autopsy found none), but a vacuum the drain had scheduled and
-- the instance could not afford. Slow queries pile up live connections, and
-- they freed only when traffic quieted at midnight.
--
-- The default trigger is `autovacuum_vacuum_scale_factor = 0.2` -- ~106k dead
-- tuples on this table -- which lets debt accumulate until the vacuum is a
-- multi-hour IO event. Dropping it to 0.02 fires at ~10k instead: many
-- affordable passes in place of one unaffordable one. The analyze factor moves
-- with it so `reltuples` stays fresh, which the embed budget's cheap
-- embedded-row estimate reads (see embedding-store.ts -> approxEmbeddedCount).
--
-- Applied to all three segment corpora, not just the table that broke: they
-- share one drain and one write pattern, so any of them reproduces this once
-- it is large enough. `kb_chunks` / `memories` / `entities` /
-- `workspace_files` are row-level primitives with far lower write volume and
-- are deliberately left on the defaults.
--
-- `ALTER TABLE ... SET (...)` on storage parameters is a catalog update: no
-- table rewrite, no scan, instant, and safe under live traffic. It does not
-- trigger a vacuum by itself -- it only changes when the next one fires.
--
-- Latest applied migration is 380 (pdf_distillates).
-- Filenames are globally unique across BOTH migration dirs (one shared
-- _migrations table).

BEGIN;

ALTER TABLE email_archive_segments SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE transcript_segments SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE file_segments SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

COMMIT;
