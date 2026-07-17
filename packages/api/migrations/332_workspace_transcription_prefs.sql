-- 332_workspace_transcription_prefs.sql
-- Workspace transcription preferences (open table).
--
-- One JSONB column, shape { languageCode?, chineseScript? }:
--   languageCode  — optional ISO 639 hint forced onto transcription providers
--                   that accept one (Scribe's `language_code` form field).
--                   Unset = provider auto-detect (the right default for
--                   multi-language workspaces).
--   chineseScript — 'traditional' | 'simplified': a post-transcription script
--                   normalization applied provider-independently in
--                   ingestRecording (OpenCC cn→hk / t→cn), so a workspace whose
--                   main language is English still gets any Chinese speech in
--                   its preferred script no matter which provider transcribed.
--
-- '{}' = provider-default behavior, exactly as before this migration. No
-- backfill. Reader is system-level + null-safe (a lookup failure must never
-- block a recording); writer is admin/owner-gated in the store setter because
-- the workspaces table carries no RLS.
--
-- See docs/architecture/media/transcription.md → "Language & script
-- preferences" and docs/architecture/platform/workspaces.md → "Transcription
-- preferences".

BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS transcription_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN workspaces.transcription_prefs IS
  'Recording transcription preference: { languageCode?, chineseScript? } (migration 332). {} = provider defaults.';

COMMIT;
