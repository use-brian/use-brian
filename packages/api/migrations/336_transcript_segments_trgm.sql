-- 336_transcript_segments_trgm.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- Make the transcript keyword arm indexed, so `transcript_segment` can join
-- KNOWN_SCOPES without turning every unscoped searchBrain into a sequential scan
-- of every transcript in the workspace.
--
-- Until now `searchRecording`'s ILIKE arm was safe ONLY because it is always
-- `recording_id`-scoped (it rides idx_transcript_segments_recording, so the
-- ILIKE only ever filters one recording's ~70-1100 rows). Unscoped, the same
-- predicate has no such gate. Verified on local PG18 before this migration:
--
--   EXPLAIN SELECT id FROM transcript_segments WHERE segment_text ILIKE '%價錢%';
--   -> Seq Scan on transcript_segments
--
-- WHY TRIGRAMS AND NOT tsvector. This was going to be a
-- `to_tsvector('simple', segment_text)` GENERATED column + GIN. It would have
-- been dead weight on precisely the content it was for. Measured on PG18:
--
--   SELECT to_tsvector('simple', '我哋傾下個價錢先啦');
--   -> '我哋傾下個價錢先啦':1
--
-- One token for the whole sentence. Postgres' default parser has no word
-- boundaries for unspaced scripts, so a Cantonese meeting transcript — the
-- motivating use case — tokenizes into a single useless lexeme per utterance,
-- and `websearch_to_tsquery('價錢')` would match nothing. `'english'` is worse
-- still (it would also stem the Latin half).
--
-- pg_trgm has no such blind spot: it indexes character trigrams, so it works on
-- ANY script, AND it accelerates the `ILIKE '%q%'` predicate the arm already
-- uses — no query rewrite, no second code path, no divergence between the scoped
-- and unscoped arms. One index, both callers.
--
-- NOTE — no `recording_ref` column. An earlier design added
-- `recording_ref UUID REFERENCES recordings(id)` alongside the existing
-- `recording_id`. That is redundant: migration 335 made `recordings.id` the
-- anchor Episode's id, so `transcript_segments.recording_id` ALREADY resolves to
-- a recording. Two columns holding the same UUID is the drift bug 331 exists to
-- prevent.
--
-- Next free migration number is 332 (latest applied is 331). Filenames are
-- globally unique across BOTH migration dirs (one shared _migrations table).

BEGIN;

-- Idempotent: pg_trgm is already present on the platform databases; this makes
-- a fresh/OSS database self-sufficient.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accelerates `segment_text ILIKE '%q%'` — the predicate BOTH the recording-
-- scoped searchRecording arm and the new unscoped transcript_segment arm use.
CREATE INDEX idx_transcript_segments_text_trgm ON transcript_segments
  USING gin (segment_text gin_trgm_ops);

-- The same latent seq-scan exists on file_segments' unscoped ILIKE arm
-- (migration 297 shipped no text index either). It is not new, but the
-- transcript arm now runs beside it on every unscoped search, so fix both while
-- the reasoning is fresh — the index is pure win: no behavior change, same
-- predicate, just planned instead of scanned.
CREATE INDEX idx_file_segments_content_trgm ON file_segments
  USING gin (content gin_trgm_ops);

COMMIT;
