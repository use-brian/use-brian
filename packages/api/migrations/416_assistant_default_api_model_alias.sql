-- 416: collapse the three per-platform assistant model aliases into one
-- honest default, and split the public surfaces onto their own tier.
--
-- Background. `assistants.{slack,telegram,whatsapp}_model_alias` predate
-- migration 197, which moved the per-channel tier onto
-- `channel_assistants.model_alias` (the routing row). Since then the three
-- columns have meant four different things at once:
--
--   * `slack_model_alias`    — dead. The Slack webhook overwrites it from the
--                              routing row before use; it only ever seeded a
--                              fresh attachment.
--   * `telegram_model_alias` — live for the hosted OFFICIAL bot (which has no
--                              `channels` row, so no routing row can carry its
--                              tier), dead for Telegram BYO (routing row wins),
--                              AND silently the tier for public-API +
--                              chat-link turns, which are not Telegram at all.
--   * `whatsapp_model_alias` — live for the hosted OFFICIAL WhatsApp bot, with
--                              no UI anywhere: permanently stuck at 'pro'.
--
-- The real axis is not the platform. It is whether the surface has a routing
-- row to carry its tier:
--
--   * has one (Slack, Telegram BYO, Discord, Teams, email, WhatsApp BYO)
--       → `channel_assistants.model_alias`, edited in Studio -> Channels.
--         The assistant only supplies the SEED for a newly attached routing row.
--   * has none (official Telegram bot, official WhatsApp bot)
--       → `assistants.default_model_alias` (this migration).
--   * has none, and is owner-paid external traffic (public API `sk_live_…`,
--     the `/c/<token>` chat link)
--       → `assistants.api_model_alias` (this migration), so a public link can
--         be capped independently of the owner's own bot.
--
-- Backfill. Both new columns take `telegram_model_alias`, which is exactly
-- what every one of those surfaces resolves through today — so this migration
-- is behaviour-preserving for the official Telegram bot, the public API, and
-- the chat link. The one intended change: the official WhatsApp bot stops
-- reading its own never-editable column and joins `default_model_alias`, so a
-- workspace that had tuned Telegram off 'pro' sees WhatsApp follow.
--
-- The three old columns are left in place (unread) for one release so a
-- rolled-back API server keeps booting; a later migration drops them.
--
-- Spec: docs/architecture/channels/adapter-pattern.md -> "Model tier: which
-- surface reads what", docs/architecture/platform/cost-and-pricing.md.

BEGIN;

ALTER TABLE assistants
  ADD COLUMN default_model_alias text NOT NULL DEFAULT 'pro',
  ADD COLUMN api_model_alias     text NOT NULL DEFAULT 'pro';

UPDATE assistants
   SET default_model_alias = telegram_model_alias,
       api_model_alias     = telegram_model_alias;

ALTER TABLE assistants
  ADD CONSTRAINT chk_default_model_alias
    CHECK (default_model_alias IN ('standard', 'pro', 'max')),
  ADD CONSTRAINT chk_api_model_alias
    CHECK (api_model_alias IN ('standard', 'pro', 'max'));

COMMENT ON COLUMN assistants.default_model_alias IS
  'Model tier for surfaces with no channel_assistants routing row (hosted official Telegram/WhatsApp bots), and the seed for a newly attached routing row. Migration 416.';
COMMENT ON COLUMN assistants.api_model_alias IS
  'Model tier for owner-paid public surfaces: the public API (sk_live_) and the /c/<token> chat link. Migration 416.';

COMMIT;
