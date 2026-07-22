-- Transcription language observability — measurement columns on `recordings`.
--
-- Cantonese and Mandarin share a writing system, so a provider asked to
-- auto-detect never reports "wrong language": it reports Chinese, returns 200,
-- and emits fluent Standard Written Chinese where the speaker said 嘅/咗/唔.
-- These columns are what make that silent normalization measurable, so the
-- provider decision can be made on production traffic rather than on public
-- benchmarks run over corpora that do not resemble it.
--
-- Every column is NULLABLE and NULL means NOT MEASURED. In particular
-- `canto_density_per_k` distinguishes NULL from 0 and they must never be
-- conflated: NULL is "no CJK present, the ratio is undefined" (an English
-- recording), 0 is "Chinese, carrying no Cantonese markers" — which is exactly
-- the normalization being hunted. Defaulting any of these to 0 would report
-- every English recording as Chinese-without-Cantonese and drag the statistics
-- with it. Recordings processed before this ships stay NULL, so a backfill gap
-- can never be read as a measurement.
--
-- Spec: docs/architecture/media/transcription.md → "Language signal".

BEGIN;

-- What the PROVIDER said it heard. Parsed from the response of providers that
-- perform language identification; never inferred from the transcript, because
-- inference is what the density below does and conflating the two would make
-- it impossible to measure one against the other.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS detected_language TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS detected_language_confidence REAL;

-- What the transcript actually READS like. Cantonese markers per 1000 CJK
-- characters, plus the raw counts it was taken over — a ratio measured across
-- 14 characters carries nothing like the weight of one measured across 50,000,
-- and keeping both is what lets an aggregate weight recordings instead of
-- averaging the averages.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS canto_density_per_k INTEGER;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS canto_marker_count INTEGER;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS cjk_count INTEGER;

-- Latin-script tokens — the code-switch signal. HK speech drops English words
-- mid-sentence, and those are measured rather than guessed at.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS latin_tokens INTEGER;

-- Four-way label from the published CanCLID classifier. Density measures
-- Cantonese PRESENCE and so cannot separate "Mandarin" from "no markers here";
-- this can. Unconstrained TEXT on purpose: a CHECK would turn an upstream
-- classifier revision into a write failure on a column that only instruments.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS chinese_variant TEXT;

-- Slicing production traffic by variant and density is the whole point, and it
-- must not require exporting the table first. Partial, because the rows that
-- matter are the measured ones and pre-ship rows are all NULL.
CREATE INDEX IF NOT EXISTS recordings_language_signal_idx
  ON recordings (chinese_variant, canto_density_per_k)
  WHERE chinese_variant IS NOT NULL;

COMMIT;
