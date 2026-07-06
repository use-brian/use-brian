-- Event run queue + storm guard.
--
-- Event dispatch now ENQUEUES workflow runs (status 'pending' — the row is
-- the queue entry) instead of inline-executing; a claim-based drain worker
-- advances them at a bounded rate. These columns are the lease bookkeeping,
-- plus the storm-guard pause reason on workflows.
--
-- Spec: docs/architecture/features/workflow.md → "Event run queue — enqueue,
-- drain, storm guard". [COMP:workflow/run-queue]

BEGIN;

-- Drain-worker lease: when the row was last claimed (NULL = never), and how
-- many times a claim was attempted. A claimed row stays 'pending' —
-- advanceWorkflowRun flips it to 'running' on first advance; a lease that
-- expires with the row still 'pending' means the claimer died and the row
-- becomes claimable again, up to the attempts cap.
ALTER TABLE workflow_runs
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN claim_attempts INT NOT NULL DEFAULT 0;

-- Claim scan: oldest pending first.
CREATE INDEX idx_workflow_runs_queue
  ON workflow_runs (started_at)
  WHERE status = 'pending';

-- Serialization / workspace-cap probes: active runs by workflow.
CREATE INDEX idx_workflow_runs_wf_active
  ON workflow_runs (workflow_id)
  WHERE status IN ('pending', 'running');

-- Storm-guard pause reason: set with enabled=false when a workflow's event
-- trigger exceeds the enqueue-rate threshold; cleared on re-enable.
ALTER TABLE workflows
  ADD COLUMN paused_reason TEXT;

COMMIT;
