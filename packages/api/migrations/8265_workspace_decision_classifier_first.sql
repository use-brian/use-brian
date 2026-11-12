-- Explicit, audited workspace-admin opt-in to native decision execution.
BEGIN;

ALTER TABLE workspace_decision_routing
  DROP CONSTRAINT workspace_decision_routing_mode_check,
  DROP CONSTRAINT workspace_decision_routing_target_check;

ALTER TABLE workspace_decision_routing
  ADD CONSTRAINT workspace_decision_routing_mode_check
    CHECK (mode IN ('llm_only', 'shadow', 'hybrid', 'classifier_first')),
  ADD CONSTRAINT workspace_decision_routing_target_check CHECK (
    (mode = 'llm_only' AND model_alias IS NULL)
    OR (mode IN ('shadow', 'hybrid', 'classifier_first') AND model_alias IS NOT NULL)
  );

COMMIT;
