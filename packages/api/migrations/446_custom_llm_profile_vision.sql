-- Custom OpenAI-compatible profiles record whether their endpoint can READ an
-- inline image, so a turn carrying a screenshot no longer has to be refused on
-- the assumption that no custom endpoint ever can.
--
-- Default false: an unverified endpoint is treated as text-only, which is the
-- v1 behavior. The connection probe flips it on for endpoints that accept an
-- `image_url` part and describe the image correctly; every profile verified
-- before this migration keeps the safe answer until it is re-verified.
BEGIN;

ALTER TABLE workspace_custom_llm_profiles
  ADD COLUMN IF NOT EXISTS supports_vision boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN workspace_custom_llm_profiles.supports_vision IS
  'Probe-verified: the endpoint accepted an inline image_url part and read it. False means image turns fall back to a built-in model.';

COMMIT;
