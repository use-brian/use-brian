-- API key audience + anonymous-context lanes (docs/plans/api-chat-modes.md §3 D1).
--
-- `audience`: 'external' (consumer-facing, the only value creatable until the
-- internal lane ships) | 'internal' (acts as an attributed workspace member).
-- Declared at creation and immutable - a leaked external key must never be
-- escalatable to internal by editing a request body.
--
-- `anonymous_context`: how much context the EXTERNAL anonymous lane gets.
-- 'thin' (default, today's behavior: reads floored to the visitor's
-- membership) | 'full' (the chat-link 'assistant-full' scope: reads at the
-- assistant's own clearance, read-only memory). Meaningless on internal keys.
--
-- Defaults keep every existing key byte-identical in behavior.

BEGIN;

ALTER TABLE api_keys
  ADD COLUMN audience TEXT NOT NULL DEFAULT 'external'
    CONSTRAINT api_keys_audience_check CHECK (audience IN ('external', 'internal')),
  ADD COLUMN anonymous_context TEXT NOT NULL DEFAULT 'thin'
    CONSTRAINT api_keys_anonymous_context_check CHECK (anonymous_context IN ('thin', 'full'));

COMMIT;
