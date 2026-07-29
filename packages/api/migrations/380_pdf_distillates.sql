-- 380: PDF distillate cache.
--
-- Full-page image distillation is the expensive half of reading a PDF for
-- every model whose registry row says `capabilities.nativePdf: false`: a
-- 40-page report is ~7 vision calls and ~84k input tokens. Without a cache
-- that is re-paid on every re-attach, every follow-up question that replays
-- history, and again when the same document arrives on a second surface.
--
-- Keyed by CONTENT HASH, not file id, deliberately: the same PDF attached in
-- web chat, dropped into Telegram, and ingested to the brain is one document
-- and distills once. `config_key` fingerprints everything that changes the
-- output for the same bytes (engine version + render width + chunk size +
-- model), so a tuning change reads as a miss instead of serving output the
-- current configuration would not have produced.
--
-- Not workspace-scoped: a row is a pure function of document bytes plus
-- config, carries no tenant linkage, and is only reachable by presenting the
-- bytes' own SHA-256. `workspace-flush` therefore needs no change.
--
-- Spec: docs/architecture/engine/file-handling.md -> "Distillate cache"
-- Plan: docs/plans/pdf-universal-read.md §4.4

BEGIN;

CREATE TABLE IF NOT EXISTS pdf_distillates (
  content_sha256  TEXT NOT NULL,
  config_key      TEXT NOT NULL,
  text            TEXT NOT NULL,
  model           TEXT NOT NULL,
  usage           JSONB,
  page_count      INT,
  -- The stored text is a PARTIAL read (page cap hit, or a chunk failed). Kept
  -- and served anyway - the distillate carries its own explicit notes about
  -- what is missing, and re-running would produce the same partial result at
  -- full cost.
  truncated       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_sha256, config_key)
);

COMMIT;
