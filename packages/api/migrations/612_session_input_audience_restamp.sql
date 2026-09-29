-- Re-stamp human input rows written under the two superseded rules
-- (scoped-context.md -> "A person's input carries the thread audience, not an
-- assistant" and "One shared-audience definition", decisions D2 / D4,
-- 2026-09-30).
--
-- 1. A person's own message was stamped private to whichever assistant
--    answered it, so a later doc-dock switch, room @mention or consult from
--    the same thread was refused over the user's own words. Their input now
--    carries no assistant.
-- 2. Doc comment threads, Feed threads and live drafts are shared audiences,
--    but their input was stamped personal to the author while delivery judged
--    them against the room. Every such row then refused each later turn in
--    that thread (user_visibility), so a thread refused once stayed refused.
--    Shared-audience input is user-less, as web rooms already were.
--
-- Only rows carrying the scope envelope are touched (legacy rows have none).
-- The canonical_scope_version trigger advances each row's version; message
-- rows hold no derived descendants on change.
BEGIN;

UPDATE session_messages
   SET assistant_id = NULL
 WHERE role = 'user'
   AND workspace_id IS NOT NULL
   AND assistant_id IS NOT NULL;

UPDATE session_messages m
   SET user_id = NULL
  FROM sessions s
 WHERE s.id = m.session_id
   AND m.role = 'user'
   AND m.workspace_id IS NOT NULL
   AND m.user_id IS NOT NULL
   AND (s.visibility = 'workspace' OR s.mode = 'draft');

COMMIT;
