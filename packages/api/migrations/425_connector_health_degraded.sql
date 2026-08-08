-- Add a fourth connector health value: 'degraded'.
--
-- Migration 294 defined health as ok / auth_failed / unknown, and `auth_failed`
-- carries a very specific meaning downstream: `mcp/inject.ts` WITHHOLDS every
-- tool belonging to an `auth_failed` instance, because the credential is dead
-- and reconnecting is the only recovery. That makes it unusable for reporting
-- "this connector's credential is fine but it is not working right now" — the
-- 2026-07-20 incident was exactly the cost of over-marking it (a fine-grained
-- GitHub PAT lacking one repo scope flipped the whole connector and the digest
-- lost GitHub everywhere).
--
-- So an ordinary failure had nowhere honest to go, and defaulted to silence:
-- on 2026-08-08 three IMAP mailboxes had been failing to sync every five
-- minutes for up to twelve days while still reporting `health_status = 'ok'`
-- to the connector card. `unknown` could not carry it either — it is the
-- never-checked state, and every surface renders it as fine.
--
--   ok           working
--   degraded     credential is VALID, but the connector is failing to do its
--                job (sync erroring, provider rejecting commands). Tools stay
--                injected: the user can still search/read/send. Reconnecting
--                is NOT the remedy.
--   auth_failed  credential is DEAD — tools withheld, reconnect required
--   unknown      reserved (never exercised)
--
-- Widening a CHECK constraint is additive and needs no backfill: no existing
-- row can violate the larger set.

BEGIN;

-- 294 declared the CHECK inline on ADD COLUMN, so its name is whatever Postgres
-- auto-generated. Dropping a GUESSED name with IF EXISTS is the dangerous form:
-- if the guess is wrong the drop is a silent no-op, the ADD below succeeds under
-- a different name, and the ORIGINAL constraint is still there rejecting
-- 'degraded' — a migration that reports success and changes nothing. Find it by
-- definition instead.
DO $$
DECLARE con_name text;
BEGIN
  FOR con_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE r.relname = 'connector_instance'
      AND n.nspname = 'public'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%health_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.connector_instance DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_health_status_check
    CHECK (health_status IN ('ok', 'auth_failed', 'degraded', 'unknown'));

COMMIT;
