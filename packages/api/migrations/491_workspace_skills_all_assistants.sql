-- 491: workspace_skills.all_assistants — stored intent, not a materialised snapshot.
--
-- Per-assistant enablement for a workspace skill is an ALLOWLIST
-- (`workspace_skill_enablement`), and every write path only ever seeded rows
-- for the assistants that existed at that instant. Rows therefore cannot
-- distinguish "offer this to everyone, forever" from "I deliberately scoped
-- this to these three" — so an assistant created LATER got nothing, and there
-- was no way to say otherwise. See
-- docs/architecture/engine/skill-system.md → "Per-assistant enablement".
--
-- `all_assistants = true` records the intent directly: the skill is offered to
-- every assistant in its workspace, including ones that do not exist yet.
-- Turning the skill off for one assistant CONVERTS the flag back into
-- materialised rows (see `materialiseAllAssistants`), so the two
-- representations never disagree.

BEGIN;

ALTER TABLE workspace_skills
  ADD COLUMN all_assistants BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN workspace_skills.all_assistants IS
  'Offer this skill to every assistant in the workspace, including ones created later. Mutually exclusive in practice with materialised workspace_skill_enablement rows: turning one assistant off converts the flag into rows.';

-- Backfill: a skill whose allowlist ALREADY covers every assistant in its
-- workspace was, in practice, the `enabledAssistantIds: 'all'` default — carry
-- that intent forward so an existing library keeps working when the next
-- assistant is created.
--
-- Deliberately conservative, because over-flipping leaks a narrowed skill to
-- future assistants while under-flipping only costs a manual toggle:
--   * a skill missing even one assistant stays materialised;
--   * a skill with NO enablement rows stays materialised (offered to nobody —
--     flipping it would grant access that never existed);
--   * `auto-generated` is excluded outright. The curator seeds exactly one row
--     (the originating assistant), which in a single-assistant workspace would
--     look identical to "all" and silently break proposer-only scope.
UPDATE workspace_skills ws
   SET all_assistants = true
 WHERE ws.source <> 'auto-generated'
   AND EXISTS (
         SELECT 1 FROM assistants a WHERE a.workspace_id = ws.workspace_id
       )
   AND NOT EXISTS (
         SELECT 1
           FROM assistants a
          WHERE a.workspace_id = ws.workspace_id
            AND NOT EXISTS (
                  SELECT 1
                    FROM workspace_skill_enablement e
                   WHERE e.workspace_skill_id = ws.id
                     AND e.assistant_id = a.id
                )
       );

-- The flag is now the authority for those rows; drop them so the two
-- representations cannot drift, and so the Access panel reads one source.
DELETE FROM workspace_skill_enablement e
 USING workspace_skills ws
 WHERE e.workspace_skill_id = ws.id
   AND ws.all_assistants = true;

COMMIT;
