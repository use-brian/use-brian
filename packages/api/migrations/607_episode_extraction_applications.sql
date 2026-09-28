-- Durable frozen Episode extraction plans and atomically receipted application.
-- Spec: docs/architecture/brain/ingest-pipeline.md
BEGIN;

CREATE TABLE episode_extraction_runs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  episode_id                 UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  attempt_key                TEXT NOT NULL CHECK (length(attempt_key) BETWEEN 1 AND 200),
  source_content_hash        TEXT NOT NULL CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
  extractor_contract_version TEXT NOT NULL CHECK (length(extractor_contract_version) BETWEEN 1 AND 120),
  plan_hash                  TEXT NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  frozen_plan               JSONB NOT NULL CHECK (
    jsonb_typeof(frozen_plan) = 'object'
    AND jsonb_typeof(frozen_plan->'candidates') = 'array'
  ),
  extraction_state          TEXT NOT NULL CHECK (extraction_state IN ('succeeded','failed','skipped')),
  application_state         TEXT NOT NULL DEFAULT 'not_started'
                              CHECK (application_state IN ('complete','partial','blocked','not_started')),
  error_code                TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
  outbox_job_id             UUID REFERENCES extraction_outbox(id) ON DELETE SET NULL,
  source_scope_version      BIGINT NOT NULL CHECK (source_scope_version > 0),
  user_id                   UUID REFERENCES users(id) ON DELETE RESTRICT,
  assistant_id              UUID REFERENCES assistants(id) ON DELETE RESTRICT,
  created_by_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by_assistant_id   UUID REFERENCES assistants(id) ON DELETE RESTRICT,
  sensitivity               TEXT NOT NULL CHECK (sensitivity IN ('public','internal','confidential','private','secret')),
  compartments              TEXT[] NOT NULL DEFAULT '{}',
  project_ids               UUID[] NOT NULL DEFAULT '{}',
  scope_held                BOOLEAN NOT NULL DEFAULT false,
  lease_owner               TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 240),
  lease_token               UUID,
  lease_until               TIMESTAMPTZ,
  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, episode_id, attempt_key),
  CHECK ((lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL)
    OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE TABLE episode_extraction_items (
  run_id             UUID NOT NULL REFERENCES episode_extraction_runs(id) ON DELETE CASCADE,
  candidate_id       TEXT NOT NULL CHECK (length(candidate_id) BETWEEN 1 AND 240),
  primitive_kind     TEXT NOT NULL CHECK (primitive_kind IN (
    'entity','edge','task','memory','ephemeral','episode_finalization',
    'digest_memory','digest_edge'
  )),
  payload_hash       TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  dependency_ids     TEXT[] NOT NULL DEFAULT '{}',
  disposition        TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN (
    'pending','committed','already_applied','held','rejected','failed'
  )),
  target_record_id   TEXT,
  receipt_id         UUID,
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_code       TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 120),
  retryable          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at         TIMESTAMPTZ,
  PRIMARY KEY (run_id, candidate_id),
  UNIQUE (receipt_id),
  CHECK (
    (disposition IN ('committed','already_applied','held','rejected') AND receipt_id IS NOT NULL)
    OR (disposition IN ('pending','failed') AND receipt_id IS NULL)
  )
);

CREATE INDEX episode_extraction_runs_workspace_created
  ON episode_extraction_runs (workspace_id, created_at DESC, id DESC);
CREATE INDEX episode_extraction_runs_episode_created
  ON episode_extraction_runs (episode_id, created_at DESC);
CREATE INDEX episode_extraction_runs_recovery
  ON episode_extraction_runs (application_state, updated_at)
  WHERE application_state IN ('not_started','partial');
CREATE INDEX episode_extraction_runs_lease_expiry
  ON episode_extraction_runs (lease_until)
  WHERE lease_token IS NOT NULL;
CREATE INDEX episode_extraction_items_retry
  ON episode_extraction_items (run_id, disposition, retryable);

-- App-role callers can inspect only rows in a current member workspace. The
-- service joins and projects the Episode before returning anything and never
-- selects frozen_plan for a user response. Writes remain owner-pool only.
ALTER TABLE episode_extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE episode_extraction_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY episode_extraction_runs_member_read ON episode_extraction_runs
  FOR SELECT USING (
    workspace_id IN (
      SELECT workspace_members.workspace_id FROM workspace_members
       WHERE workspace_members.user_id = nullif(current_setting('app.current_user_id', true),'')::uuid
    )
    AND NOT scope_held
  );
CREATE POLICY episode_extraction_items_member_read ON episode_extraction_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM episode_extraction_runs run
       WHERE run.id = episode_extraction_items.run_id AND NOT run.scope_held
    )
  );

CREATE FUNCTION protect_episode_extraction_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF ROW(NEW.workspace_id,NEW.episode_id,NEW.attempt_key,NEW.source_content_hash,
      NEW.extractor_contract_version,NEW.plan_hash,NEW.frozen_plan,
      NEW.extraction_state,NEW.outbox_job_id,NEW.source_scope_version,
      NEW.user_id,NEW.assistant_id,NEW.created_by_user_id,
      NEW.created_by_assistant_id,NEW.sensitivity,NEW.compartments,NEW.project_ids)
    IS DISTINCT FROM
     ROW(OLD.workspace_id,OLD.episode_id,OLD.attempt_key,OLD.source_content_hash,
      OLD.extractor_contract_version,OLD.plan_hash,OLD.frozen_plan,
      OLD.extraction_state,OLD.outbox_job_id,OLD.source_scope_version,
      OLD.user_id,OLD.assistant_id,OLD.created_by_user_id,
      OLD.created_by_assistant_id,OLD.sensitivity,OLD.compartments,OLD.project_ids)
    OR (OLD.scope_held AND NOT NEW.scope_held) THEN
    RAISE EXCEPTION 'episode_extraction_run_immutable';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION protect_episode_extraction_run() FROM PUBLIC;
CREATE TRIGGER protect_episode_extraction_run
  BEFORE UPDATE ON episode_extraction_runs
  FOR EACH ROW EXECUTE FUNCTION protect_episode_extraction_run();

CREATE FUNCTION protect_episode_extraction_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF ROW(NEW.run_id,NEW.candidate_id,NEW.primitive_kind,NEW.payload_hash,NEW.dependency_ids)
    IS DISTINCT FROM ROW(OLD.run_id,OLD.candidate_id,OLD.primitive_kind,OLD.payload_hash,OLD.dependency_ids)
    OR OLD.disposition IN ('committed','already_applied','held','rejected') THEN
    RAISE EXCEPTION 'episode_extraction_item_immutable';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION protect_episode_extraction_item() FROM PUBLIC;
CREATE TRIGGER protect_episode_extraction_item
  BEFORE UPDATE ON episode_extraction_items
  FOR EACH ROW EXECUTE FUNCTION protect_episode_extraction_item();

-- A changed/held/erased source immediately fences replay. Episode deletion
-- cascades the content-bearing plan and every receipt.
CREATE FUNCTION fence_episode_extraction_application() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.scope_version IS DISTINCT FROM OLD.scope_version
    OR NEW.scope_held IS DISTINCT FROM OLD.scope_held
    OR (NOT OLD.extraction_locked AND NEW.extraction_locked) THEN
    UPDATE episode_extraction_runs
       SET application_state='blocked', error_code='source_changed',
           scope_held=(NEW.scope_held OR NEW.extraction_locked),
           lease_owner=NULL, lease_token=NULL, lease_until=NULL
     WHERE episode_id=NEW.id AND application_state <> 'complete';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION fence_episode_extraction_application() FROM PUBLIC;
CREATE TRIGGER fence_episode_extraction_application
  AFTER UPDATE OF scope_version,scope_held,extraction_locked ON episodes
  FOR EACH ROW EXECUTE FUNCTION fence_episode_extraction_application();

-- Register the new derived/replay family. Existing reviewed revision 1 can no
-- longer certify strict readiness until an administrator reviews revision 2.
CREATE OR REPLACE FUNCTION scope_review_registry_revision() RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT 2::bigint $$;
REVOKE ALL ON FUNCTION scope_review_registry_revision() FROM PUBLIC;

COMMIT;
