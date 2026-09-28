-- 605_decision_evaluation_profiles.sql  (OPEN table)
--
-- Audited, version-exact classifier promotion evidence. Evidence is immutable;
-- revocation changes only the active status and its audit metadata. Segment is
-- part of identity so one language/data cohort cannot authorize another.

BEGIN;

ALTER TABLE workspace_decision_routing
  DROP CONSTRAINT IF EXISTS workspace_decision_routing_mode_check;
ALTER TABLE workspace_decision_routing
  DROP CONSTRAINT IF EXISTS workspace_decision_routing_check;
ALTER TABLE workspace_decision_routing
  ADD CONSTRAINT workspace_decision_routing_mode_check
    CHECK (mode IN ('llm_only', 'shadow', 'hybrid')),
  ADD CONSTRAINT workspace_decision_routing_target_check CHECK (
    (mode = 'llm_only' AND model_alias IS NULL)
    OR (mode IN ('shadow', 'hybrid') AND model_alias IS NOT NULL)
  );

CREATE TABLE decision_evaluation_profiles (
  profile_id          TEXT NOT NULL,
  profile_version     TEXT NOT NULL,
  operation_id        TEXT NOT NULL,
  operation_version   TEXT NOT NULL,
  state_version       TEXT NOT NULL,
  question_version    TEXT NOT NULL,
  model_catalog_id    TEXT NOT NULL,
  model_wire_id       TEXT NOT NULL,
  evaluation_segment  TEXT NOT NULL CHECK (length(evaluation_segment) BETWEEN 1 AND 120),
  status              TEXT NOT NULL DEFAULT 'approved'
                        CHECK (status IN ('approved', 'revoked')),
  profile              JSONB NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  report               JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  report_sha256        TEXT NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by          TEXT NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 256),
  approved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by           TEXT CHECK (revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 256),
  revoked_at           TIMESTAMPTZ,
  revocation_reason    TEXT CHECK (revocation_reason IS NULL OR length(revocation_reason) BETWEEN 1 AND 1000),
  PRIMARY KEY (profile_id, profile_version),
  CHECK (
    (status = 'approved' AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX decision_evaluation_profiles_active_exact_idx
  ON decision_evaluation_profiles (
    operation_id,
    operation_version,
    state_version,
    question_version,
    model_catalog_id,
    model_wire_id,
    evaluation_segment
  )
  WHERE status = 'approved';

CREATE INDEX decision_evaluation_profiles_active_model_idx
  ON decision_evaluation_profiles (model_catalog_id, operation_id, evaluation_segment)
  WHERE status = 'approved';

COMMENT ON TABLE decision_evaluation_profiles IS
  'System-pool-only immutable aggregate evidence for exact-version classifier promotion; raw fixtures are never stored';

COMMIT;
