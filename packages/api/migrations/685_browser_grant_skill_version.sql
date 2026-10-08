-- Exact reviewed skill version. Legacy grants remain unbound and require review.
BEGIN;
ALTER TABLE browser_skill_grants
  ADD COLUMN skill_version integer CHECK (skill_version > 0);
COMMIT;
