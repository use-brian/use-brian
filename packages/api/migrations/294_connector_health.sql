BEGIN;

-- Connector health / liveness. See docs/architecture/integrations/connector-health.md
-- and docs/plans/connector-health-liveness.md.
--
-- `connected` records user INTENT ("this connector is set up"). `health_status`
-- records TRUTH ("its credentials actually work right now"): flipped to
-- 'auth_failed' at call time when a connector tool returns 401/403, reset to
-- 'ok' on a subsequent successful call or an explicit reconnect. The two are
-- deliberately separate columns — never overload `connected`.
--
--   ok           credentials worked on last use (default for existing rows)
--   auth_failed  a 401/403/invalid_grant/bad-credentials at call time
--   unknown      reserved (never exercised)
ALTER TABLE connector_instance
  ADD COLUMN health_status text NOT NULL DEFAULT 'ok'
    CHECK (health_status IN ('ok', 'auth_failed', 'unknown')),
  ADD COLUMN last_error text,
  ADD COLUMN last_checked_at timestamptz;

COMMIT;
