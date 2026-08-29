BEGIN;

-- Simplified Chinese (zh-CN) joins the magic-link email locales; widen
-- the allowlist to match MagicLinkLocale in db/magic-link-store.ts.
ALTER TABLE magic_link_tokens
  DROP CONSTRAINT magic_link_tokens_locale_check;
ALTER TABLE magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_locale_check
  CHECK ((locale IS NULL) OR (locale = ANY (ARRAY['en'::text, 'ja'::text, 'zh'::text, 'zh-CN'::text])));

COMMIT;
