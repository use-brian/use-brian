-- [COMP:api/skill-store] Restore the two-role owner path before the 8220 backfill.
-- 602 forced RLS and requires the retired app.system_bypass GUC for writes.
-- The migration owner and owner-owned receipt triggers use ownership instead.
-- Keep application-role RLS and every existing policy enabled and unchanged.
BEGIN;
ALTER TABLE public.workspace_skill_scope_revisions NO FORCE ROW LEVEL SECURITY;
COMMIT;
