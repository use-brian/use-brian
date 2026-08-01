-- 389: session_pins — pinned room context (multiplayer chat P1b, T14/D10;
-- docs/plans/multiplayer-chat.md).
--
-- Members pin a room's working set — pages, tasks, contacts, companies,
-- deals, files, URLs, freeform background instructions — and every assistant
-- turn assembles inside that frame. Session-generic on purpose (personal
-- chats can adopt later); the room surface is the first renderer.
--
-- Pins are REFERENCES, resolved fresh at assembly under the session's
-- effective clearance (T15) — never inlined content, so a pin can't smuggle
-- data above the room's level and an edited primitive is always current.

BEGIN;

CREATE TABLE IF NOT EXISTS session_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('page','task','contact','company','deal','file','url','instruction')),
  -- Exactly one payload column per kind family:
  --   brain primitives (page/task/contact/company/deal/file) carry ref_id;
  --   url carries url; instruction carries text (app-capped ~2k chars).
  ref_id uuid,
  url text,
  text text,
  "position" integer NOT NULL DEFAULT 0,
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_pins_payload_check CHECK (
    (kind IN ('page','task','contact','company','deal','file') AND ref_id IS NOT NULL AND url IS NULL AND text IS NULL)
    OR (kind = 'url' AND url IS NOT NULL AND ref_id IS NULL AND text IS NULL)
    OR (kind = 'instruction' AND text IS NOT NULL AND ref_id IS NULL AND url IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_session_pins_session ON session_pins(session_id, "position", created_at);

COMMIT;
