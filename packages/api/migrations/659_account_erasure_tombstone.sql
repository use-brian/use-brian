-- Account deletion for a member of other people's workspaces.
-- Spec: docs/architecture/features/privacy-controls.md -> "Teardown order".
--
-- A member who leaves cannot always have their `users` row deleted: audit and
-- evidence rows in other workspaces name them, and those tables are
-- tamper-evident by design. Such an account is TOMBSTONED instead: personal
-- data deleted, identity scrubbed, sign-in impossible, and every remaining
-- reference renders as a deleted user. `users.deleted_at` marks it.
--
-- One evidence guard must still admit one change: a pinned workflow the
-- leaver authored moves to the workspace owner while being disabled (founder
-- decision 2026-10-03: ownership moves, the schedule pauses for review).
-- `account_erasure_allows` admits exactly that, and only inside the
-- transaction that registered the erasure in `account_erasures` (owner pool
-- only; app_user has no access).

BEGIN;

ALTER TABLE users ADD COLUMN deleted_at timestamptz;

CREATE TABLE account_erasures (
  txid text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE account_erasures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON account_erasures FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON account_erasures FROM app_user;
  END IF;
END $$;

-- The leaving user, when the CURRENT transaction registered an erasure.
CREATE OR REPLACE FUNCTION public.account_erasure_leaver()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT e.user_id::text FROM account_erasures e
   WHERE e.txid = pg_current_xact_id_if_assigned()::text
$$;

-- True only for an UPDATE the account teardown performs: nothing but the
-- listed columns (and updated_at) changed, and each changed column went from
-- the leaver to NULL or to the row's workspace owner.
CREATE OR REPLACE FUNCTION public.account_erasure_allows(old_row jsonb, new_row jsonb, cols text[])
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  leaver text := account_erasure_leaver();
  ws_owner text;
  c text;
  o jsonb;
  n jsonb;
  changed boolean := false;
BEGIN
  IF leaver IS NULL THEN RETURN false; END IF;
  IF (old_row - cols - 'updated_at') IS DISTINCT FROM (new_row - cols - 'updated_at') THEN
    RETURN false;
  END IF;
  SELECT w.owner_user_id::text INTO ws_owner
    FROM workspaces w WHERE w.id = nullif(old_row ->> 'workspace_id', '')::uuid;
  FOREACH c IN ARRAY cols LOOP
    o := old_row -> c;
    n := new_row -> c;
    CONTINUE WHEN o IS NOT DISTINCT FROM n;
    IF (o #>> '{}') IS DISTINCT FROM leaver THEN RETURN false; END IF;
    IF jsonb_typeof(n) <> 'null' AND ((n #>> '{}') IS DISTINCT FROM ws_owner OR ws_owner = leaver) THEN
      RETURN false;
    END IF;
    changed := true;
  END LOOP;
  RETURN changed;
END;
$$;

-- Pinned workflows: admit the ownership move only while the workflow is
-- disabled. The CASE keeps the hot path to one setting read.
DROP TRIGGER pinned_workflow_definition_immutable ON workflows;
CREATE TRIGGER pinned_workflow_definition_immutable
  BEFORE UPDATE ON workflows FOR EACH ROW
  WHEN (CASE WHEN nullif(current_setting('app.account_erasure', true), '') IS NULL THEN true
             ELSE NOT (NOT NEW.enabled
                       AND account_erasure_allows(to_jsonb(OLD), to_jsonb(NEW), ARRAY['created_by']))
        END)
  EXECUTE FUNCTION protect_pinned_workflow_schedule();

COMMIT;
