-- Assistant charter (docs/plans/assistant-growth-loop.md §2-§3, Phase 1).
--
-- Collapses the two-field identity (`bio` + `system_prompt`) into one
-- `charter` JSONB: { mission, audience, success, instructions }. Typed where a
-- mechanism reads the field (mission feeds the assistant's own prompt, peer
-- `purpose`, the public chat-link header, app souls, and the Phase-3
-- reflection rubric via `success`); free prose in `instructions`.
--
-- Semantics are authoritative-if-present (§2 D4): a non-null charter is the
-- whole truth; `bio` / `system_prompt` are read only when charter IS NULL.
-- The backfill below makes that fallback defensive-only. Legacy columns are
-- deliberately NOT dropped (§2 D7) - old clients still PATCH/read them via
-- the route-level fold.

BEGIN;

ALTER TABLE assistants ADD COLUMN charter JSONB;

UPDATE assistants
SET charter = jsonb_strip_nulls(jsonb_build_object(
  'mission', NULLIF(btrim(bio), ''),
  'instructions', NULLIF(btrim(system_prompt), '')
))
WHERE (bio IS NOT NULL AND btrim(bio) <> '')
   OR (system_prompt IS NOT NULL AND btrim(system_prompt) <> '');

COMMIT;
