-- 301_skill_blueprint_id.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- Link a skill to the v2 blueprint it fills (structural-synthesis, Phase 2:
-- skill auto-blueprint). When a skill's job is to produce a STRUCTURED artifact,
-- the draft generator emits an `extraction` spec instead of baking format prose
-- into the body; on save the API mints a `workspace_page_templates` blueprint
-- and stamps its id here. Nullable: most skills are purely procedural and carry
-- no blueprint. ON DELETE SET NULL so deleting the blueprint degrades the skill
-- to procedural (its body still runs), never orphans it. See
-- docs/architecture/brain/structural-synthesis.md -> "The blueprint object".
--
-- Next free OPEN migration number is 301 (300 is synthesis_surcharges).

BEGIN;

ALTER TABLE workspace_skills
  ADD COLUMN IF NOT EXISTS blueprint_id UUID
    REFERENCES workspace_page_templates(id) ON DELETE SET NULL;

COMMIT;
