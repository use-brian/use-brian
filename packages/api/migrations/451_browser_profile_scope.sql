-- Browser profiles: separate SCOPE from CLEARANCE.
--
-- `clearance` was overloaded: a rung on the shared public < internal <
-- confidential ladder AND, at its top value, "owner-only". So "only me" was
-- not expressible on its own - asking for a private browsing identity also
-- imposed a top-clearance bar on the owner's own assistants. Profiles default
-- to `confidential` (438) while ordinary assistants are created at `internal`,
-- so the DEFAULT pairing was refused (incident 2026-08-19).
--
-- Plan: docs/plans/browser-profile-scope-and-clearance.md §3.

BEGIN;

ALTER TABLE public.browser_profiles
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'owner'
    CHECK (scope IN ('owner', 'workspace'));

-- Preserve today's behaviour exactly: `confidential` WAS owner-only, every
-- lower rung was workspace-visible at that rung.
UPDATE public.browser_profiles
   SET scope = CASE WHEN clearance = 'confidential' THEN 'owner' ELSE 'workspace' END;

-- `clearance` is deliberately LEFT UNTOUCHED on migrated rows. It is ignored
-- while scope = 'owner', and preserving it means a later flip to 'workspace'
-- restores the strictest reading rather than silently widening.

-- The session-vault policy welded the same two ideas together
-- (`bp.clearance <> 'confidential'` meant "is shared"). Say what is meant.
DROP POLICY IF EXISTS browser_sessions_by_clearance ON public.browser_sessions;
CREATE POLICY browser_sessions_by_clearance ON public.browser_sessions
  USING (
    user_id = (current_setting('app.current_user_id', true))::uuid
    OR EXISTS (
      SELECT 1
      FROM public.browser_profiles bp
      JOIN public.workspace_members wm
        ON wm.workspace_id = bp.workspace_id
       AND wm.user_id = (current_setting('app.current_user_id', true))::uuid
      WHERE bp.id = browser_sessions.profile_id
        AND bp.scope = 'workspace'
        AND (CASE wm.clearance WHEN 'confidential' THEN 3 WHEN 'internal' THEN 2 ELSE 1 END)
            >= (CASE bp.clearance WHEN 'confidential' THEN 3 WHEN 'internal' THEN 2 ELSE 1 END)
    )
  );

COMMIT;
