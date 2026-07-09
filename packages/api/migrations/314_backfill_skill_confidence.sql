-- 314_backfill_skill_confidence.sql
--
-- Graded-confidence backfill. The old governance model keyed birth confidence off
-- `source`, so every human-approved self-learned skill was minted `source='user'` →
-- confidence 1.0 + activated, WITHOUT ever stamping the verifier. That produced the
-- contradictory "ACTIVE · 100% · Not verified yet · Never used" state. The old
-- re-derivation path (+0.5, auto-activate at 1.0) could also lift an un-verified skill
-- to 1.0. Under the graded model only human confirmation reaches 1.0; usage and
-- re-derivation cap at 0.9. This migration reconciles existing rows with that model.
--
-- Spec: docs/architecture/engine/skill-system.md §"Governance — graded confidence".

BEGIN;

-- Part 1 — authored skills at certified confidence but never stamped verified.
-- Authoring IS the human certification, so restore the "confidence 1.0 ⇔ verified"
-- invariant by stamping the author as verifier at the row's creation time. (Community
-- rows are published authored skills; they carry an author_id and are covered here.)
UPDATE workspace_skills
SET verified_by_user_id = COALESCE(verified_by_user_id, author_id),
    verified_at = COALESCE(verified_at, created_at)
WHERE induction_source = 'authored'
  AND confidence >= 1.0
  AND verified_at IS NULL
  AND author_id IS NOT NULL;

-- Part 2 — self / ingested skills sitting above the usage cap without human
-- verification. They were never certified, so recompute confidence from history under
-- the graded formula: born medium (0.5 self / 0.0 ingested) + 0.05 per corrected-free
-- success + 0.05 per independent re-derivation, capped at 0.9. A never-used, never
-- re-derived self skill (the reported case) lands back at its honest 0.5. Activation
-- (activated_at) is left untouched: self skills are active from birth under the new
-- model, they simply stop claiming certified confidence.
UPDATE workspace_skills
SET confidence = LEAST(
      (CASE induction_source WHEN 'self' THEN 0.5 ELSE 0.0 END)
        + 0.05 * (succeeded + rederivation_count),
      0.9
    ),
    updated_at = now()
WHERE induction_source IN ('self', 'ingested')
  AND verified_at IS NULL
  AND confidence > 0.9;

COMMIT;
