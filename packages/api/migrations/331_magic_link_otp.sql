-- 331_magic_link_otp.sql
--
-- Add a one-time passcode (OTP) alongside the magic-link token so a user can
-- sign in by typing a 6-digit code on any device instead of clicking the link.
-- This is the cross-device / prefetch-proof half of the magic-link hardening:
-- the emailed link now lands on a confirm page (no consume-on-GET), and the
-- code is an alternative that email link-scanners / prefetchers cannot exercise
-- (they can't type a code).
--
-- See docs/architecture/platform/auth.md -> "Email magic-link flow".
--
--   code_hash     — sha256("<email>:<code>"), salted per-email so a DB dump
--                   can't rainbow-table the 6-digit space across rows. NULL on
--                   pre-migration rows (their links still verify by token).
--   code_attempts — failed verify-code guesses burnt against this email's
--                   active codes; the route locks the code out at the cap
--                   (CODE_MAX_ATTEMPTS) to bound brute force of the 6-digit space.

BEGIN;

ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS code_hash text,
  ADD COLUMN IF NOT EXISTS code_attempts integer NOT NULL DEFAULT 0;

-- Lookup path for consumeByCode: (email, code_hash) among active rows. The
-- existing (email, created_at) index doesn't cover the code match; request-link
-- caps active codes per email at 3/hour so this stays tiny, but the index keeps
-- the atomic consume a single-row probe.
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email_code
  ON magic_link_tokens (email, code_hash);

COMMIT;
