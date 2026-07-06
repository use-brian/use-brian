-- 300_synthesis_surcharges.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- The user-initiated GENERATE-from-brain surcharge ledger (structural-synthesis).
--
-- Why a dedicated ledger, mirroring recording_surcharges (281):
-- the live credit gate is DERIVED — getPeriodCredits SUMs usage_tracking rows,
-- but ONLY those carrying a user_message_id or trigger_key='main_response'
-- (credit-gate.ts). A standalone synthesis run has neither, so its cost cannot
-- ride the derived ledger. A dedicated surcharge row per charged run composes
-- additively with the derived total (SUM(credits) WHERE charged_at >= periodStart),
-- is naturally period-aware, idempotent (UNIQUE request_id — one charge per
-- confirmed run, the on-success debit retries safely), and auditable. It writes
-- NO usage_tracking row, so the engine's own overhead:synthesis COGS row is the
-- only usage_tracking entry (no phantom double-count). See
-- docs/architecture/brain/structural-synthesis.md → "Locked invariants" and
-- docs/architecture/engine/preflight-confirmation.md.
--
-- Next free OPEN migration number is 300 (299 is file_cache_artifact_link).

BEGIN;

CREATE TABLE synthesis_surcharges (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Client-minted per confirmed generate action. Idempotency key: a retried
  -- POST /generate (network retry) with the same request_id charges once.
  request_id         UUID NOT NULL,
  -- The blueprint that was filled. SET NULL so deleting the blueprint keeps the
  -- audit row. Plain (no FK) page_id — an audit reference, not a hard relation.
  blueprint_id       UUID REFERENCES workspace_page_templates(id) ON DELETE SET NULL,
  page_id            UUID,
  subject            TEXT,
  section_count      INT,
  credits            NUMERIC NOT NULL CHECK (credits >= 0),
  charged_by_user_id UUID,
  charged_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id)
);

CREATE INDEX idx_synthesis_surcharges_ws_period ON synthesis_surcharges (workspace_id, charged_at);

-- RLS: workspace-membership read (the billing/usage UI). Writes run on the
-- system pool (the generate route's on-success debit). NULL-safe two-arg
-- current_setting (unset GUC -> NULL -> zero rows on the system/unauth path).
ALTER TABLE synthesis_surcharges ENABLE ROW LEVEL SECURITY;
CREATE POLICY synthesis_surcharges_workspace_member ON synthesis_surcharges
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
