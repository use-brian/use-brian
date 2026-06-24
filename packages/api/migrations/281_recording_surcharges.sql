-- 281_recording_surcharges.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- The long-recording duration surcharge ledger (recording-to-brain Phase 4).
--
-- Why a dedicated table, not workspaces.credits_used_this_period:
-- the live credit gate is DERIVED — getPeriodCredits SUMs usage rows since the
-- billing-period start (credit-gate.ts). A running counter on `workspaces`
-- would need period-reset bookkeeping the derived model never needs. A ledger
-- row per charged recording composes additively with the derived total
-- (SUM(credits) WHERE charged_at >= periodStart) and is naturally period-aware,
-- idempotent (UNIQUE recording_id — one charge per recording, the on-success
-- debit can retry safely), and auditable. It writes NO usage_tracking row, so
-- no phantom model call pollutes admin COGS. See docs/plans/recording-to-brain.md
-- §Billing.
--
-- Next free OPEN migration number is 281 (280 is transcript_segments).

BEGIN;

CREATE TABLE recording_surcharges (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recording_id       UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  credits            NUMERIC NOT NULL CHECK (credits >= 0),
  duration_seconds   INT,
  charged_by_user_id UUID,
  charged_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent: at most one surcharge per recording. The on-success debit uses
  -- ON CONFLICT DO NOTHING so a retried transcription job never double-charges.
  UNIQUE (recording_id)
);

CREATE INDEX idx_recording_surcharges_ws_period ON recording_surcharges (workspace_id, charged_at);

-- RLS: workspace-membership read (the billing/usage UI). Writes run on the
-- system pool (the background transcription job). NULL-safe two-arg
-- current_setting (unset GUC -> NULL -> zero rows on the system/unauth path).
ALTER TABLE recording_surcharges ENABLE ROW LEVEL SECURITY;
CREATE POLICY recording_surcharges_workspace_member ON recording_surcharges
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
