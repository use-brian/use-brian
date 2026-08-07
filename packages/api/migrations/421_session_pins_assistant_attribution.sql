-- 421: session_pins.added_by_assistant_id — assistant-added pins.
--
-- Assistants can now pin materials into a room's Work Bench through room-only
-- chat tools ("pin all tasks in this project here"), so a pin's author may be
-- an assistant rather than a member. Attribution stays one column per author
-- family, mirroring added_by_user_id: exactly one of the two is set per row
-- (not constrained — legacy rows keep user attribution untouched).

BEGIN;

ALTER TABLE session_pins
  ADD COLUMN IF NOT EXISTS added_by_assistant_id uuid REFERENCES assistants(id) ON DELETE SET NULL;

COMMIT;
