-- [COMP:decisions/workspace-routing] Selectable workspace shadow sampling.
-- Existing rows retain 10% sampling; sampling never grants classifier authority.
BEGIN;

ALTER TABLE workspace_decision_routing
  ADD COLUMN shadow_sample_rate DOUBLE PRECISION NOT NULL DEFAULT 0.1
    CHECK (shadow_sample_rate IN (0.1, 1));

COMMIT;
