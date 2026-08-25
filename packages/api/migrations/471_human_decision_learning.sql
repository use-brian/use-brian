-- Human decision learning: immutable decision evidence, cross-domain provenance,
-- deterministic CRM identity state, and user-scoped playbook metadata.
--
-- Domain tables remain authoritative. These tables carry bounded provenance and
-- causality only; no email body, prompt, tool arguments, transcript, or entity
-- snapshot belongs in them.

BEGIN;

CREATE TABLE decision_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 64),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
  artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(artifact_refs) = 'array' AND jsonb_array_length(artifact_refs) <= 20),
  source_kind TEXT CHECK (source_kind IS NULL OR length(source_kind) BETWEEN 1 AND 64),
  source_id TEXT CHECK (source_id IS NULL OR length(source_id) BETWEEN 1 AND 512),
  visibility TEXT NOT NULL CHECK (visibility IN ('owner', 'workspace')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE decision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  event_kind TEXT NOT NULL CHECK (length(event_kind) BETWEEN 1 AND 128),
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  source_kind TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 512),
  declared_scope TEXT NOT NULL
    CHECK (declared_scope IN ('instance', 'entity', 'account', 'tool', 'user', 'assistant', 'workspace')),
  visibility TEXT NOT NULL CHECK (visibility IN ('owner', 'workspace')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  caused_by_event_id UUID REFERENCES decision_events(id) ON DELETE SET NULL,
  caused_by_application_id UUID REFERENCES decision_applications(id) ON DELETE SET NULL,
  reverses_event_id UUID REFERENCES decision_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decision_events_workspace_created
  ON decision_events (workspace_id, created_at DESC, id DESC);
CREATE INDEX idx_decision_events_assistant_actor_created
  ON decision_events (assistant_id, actor_user_id, created_at DESC);
CREATE INDEX idx_decision_events_kind_created
  ON decision_events (event_kind, created_at DESC);

CREATE TABLE decision_derivations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_event_id UUID NOT NULL REFERENCES decision_events(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL CHECK (length(artifact_kind) BETWEEN 1 AND 64),
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 512),
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'invalidates')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (decision_event_id, artifact_kind, artifact_id, relation)
);

CREATE INDEX idx_decision_derivations_artifact
  ON decision_derivations (artifact_kind, artifact_id, created_at DESC);
CREATE INDEX idx_decision_derivations_workspace_created
  ON decision_derivations (workspace_id, created_at DESC);
CREATE INDEX idx_decision_applications_actor_assistant_created
  ON decision_applications (assistant_id, actor_user_id, created_at DESC);

-- `entities.id` is globally unique already; this companion unique key lets the
-- CRM tables carry a composite workspace/id FK so a cross-workspace pointer is
-- impossible even before the store revalidates under lock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_workspace_id_unique
  ON entities (workspace_id, id);

CREATE TABLE crm_identity_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  provider_instance_key TEXT NOT NULL CHECK (length(provider_instance_key) BETWEEN 1 AND 256),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 512),
  entity_id UUID NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'internal'
    CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  bound_by_decision_event_id UUID REFERENCES decision_events(id) ON DELETE SET NULL,
  revoked_by_decision_event_id UUID REFERENCES decision_events(id) ON DELETE SET NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, entity_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE,
  CHECK ((revoked_at IS NULL) = (revoked_by_decision_event_id IS NULL))
);

CREATE UNIQUE INDEX idx_crm_identity_bindings_active_namespace
  ON crm_identity_bindings (workspace_id, provider, provider_instance_key, subject_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_crm_identity_bindings_entity
  ON crm_identity_bindings (workspace_id, entity_id) WHERE revoked_at IS NULL;

CREATE TABLE crm_entity_separations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  left_entity_id UUID NOT NULL,
  right_entity_id UUID NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sensitivity TEXT NOT NULL DEFAULT 'internal'
    CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  created_by_decision_event_id UUID REFERENCES decision_events(id) ON DELETE SET NULL,
  invalidated_by_decision_event_id UUID REFERENCES decision_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at TIMESTAMPTZ,
  FOREIGN KEY (workspace_id, left_entity_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, right_entity_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE,
  CHECK (left_entity_id < right_entity_id),
  CHECK ((invalidated_at IS NULL) = (invalidated_by_decision_event_id IS NULL))
);

CREATE UNIQUE INDEX idx_crm_entity_separations_active_pair
  ON crm_entity_separations (workspace_id, left_entity_id, right_entity_id)
  WHERE invalidated_at IS NULL;
CREATE INDEX idx_crm_entity_separations_workspace_created
  ON crm_entity_separations (workspace_id, created_at DESC);

ALTER TABLE assistant_playbook_rules
  ADD COLUMN applies_to_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN applicability_kind TEXT NOT NULL DEFAULT 'general'
    CHECK (applicability_kind IN ('general', 'email', 'tool')),
  ADD COLUMN applicability_key TEXT
    CHECK (applicability_key IS NULL OR length(applicability_key) <= 256),
  ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  ADD COLUMN semantic_key TEXT CHECK (semantic_key IS NULL OR length(semantic_key) <= 256);

ALTER TABLE assistant_playbook_rules
  DROP CONSTRAINT assistant_playbook_rules_created_by_check;
ALTER TABLE assistant_playbook_rules
  ADD CONSTRAINT assistant_playbook_rules_created_by_check
  CHECK (created_by IN ('reflection', 'owner', 'decision_reflection'));

CREATE UNIQUE INDEX idx_playbook_decision_semantic_key
  ON assistant_playbook_rules (assistant_id, applies_to_user_id, semantic_key)
  WHERE semantic_key IS NOT NULL;
CREATE INDEX idx_playbook_user_scope_status
  ON assistant_playbook_rules (assistant_id, applies_to_user_id, status, created_at DESC);

-- Append-only at the database boundary. Erasure/flush uses DELETE and remains
-- legal; no application path may rewrite evidence or provenance.
CREATE FUNCTION reject_decision_append_only_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER decision_events_reject_update
  BEFORE UPDATE ON decision_events
  FOR EACH ROW EXECUTE FUNCTION reject_decision_append_only_update();
CREATE TRIGGER decision_derivations_reject_update
  BEFORE UPDATE ON decision_derivations
  FOR EACH ROW EXECUTE FUNCTION reject_decision_append_only_update();
CREATE TRIGGER decision_applications_reject_update
  BEFORE UPDATE ON decision_applications
  FOR EACH ROW EXECUTE FUNCTION reject_decision_append_only_update();

ALTER TABLE decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_derivations ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_identity_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_entity_separations ENABLE ROW LEVEL SECURITY;

CREATE POLICY decision_events_member ON decision_events
  USING (
    actor_user_id = current_setting('app.current_user_id', true)::uuid
    OR (
      visibility = 'workspace'
      AND workspace_id IN (
        SELECT wm.workspace_id FROM workspace_members wm
         WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
           AND public.sensitivity_rank(decision_events.sensitivity)
               <= public.sensitivity_rank(wm.clearance)
      )
    )
  )
  WITH CHECK (
    actor_user_id = current_setting('app.current_user_id', true)::uuid
    AND (
      workspace_id IS NULL
      OR workspace_id IN (
        SELECT wm.workspace_id FROM workspace_members wm
         WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
      )
    )
  );

CREATE POLICY decision_derivations_member ON decision_derivations
  USING (EXISTS (
    SELECT 1 FROM decision_events de WHERE de.id = decision_event_id
  ));

CREATE POLICY decision_applications_member ON decision_applications
  USING (
    actor_user_id = current_setting('app.current_user_id', true)::uuid
    OR (
      visibility = 'workspace'
      AND workspace_id IN (
        SELECT wm.workspace_id FROM workspace_members wm
         WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
           AND public.sensitivity_rank(decision_applications.sensitivity)
               <= public.sensitivity_rank(wm.clearance)
      )
    )
  )
  WITH CHECK (actor_user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY crm_identity_bindings_member ON crm_identity_bindings
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM workspace_members wm
     WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
       AND public.sensitivity_rank(crm_identity_bindings.sensitivity)
           <= public.sensitivity_rank(wm.clearance)
  ));

CREATE POLICY crm_entity_separations_member ON crm_entity_separations
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM workspace_members wm
     WHERE wm.user_id = current_setting('app.current_user_id', true)::uuid
       AND public.sensitivity_rank(crm_entity_separations.sensitivity)
           <= public.sensitivity_rank(wm.clearance)
  ));

-- The owner/system connection bypasses RLS normally. These explicit policies
-- preserve the same worker seam for environments that force RLS and set the
-- standard app.system_bypass GUC.
CREATE POLICY decision_events_system_bypass ON decision_events
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');
CREATE POLICY decision_derivations_system_bypass ON decision_derivations
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');
CREATE POLICY decision_applications_system_bypass ON decision_applications
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');
CREATE POLICY crm_identity_bindings_system_bypass ON crm_identity_bindings
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');
CREATE POLICY crm_entity_separations_system_bypass ON crm_entity_separations
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

-- Historical CRM bootstrap: every merge gets deterministic decision evidence;
-- undone merges get a reversing event linked to the original. Structured
-- identity materialization is an idempotent store pass because provider schemas
-- require application validation and collision reporting.
INSERT INTO decision_events (
  idempotency_key, workspace_id, actor_user_id, event_kind, schema_version,
  source_kind, source_id, declared_scope, visibility, sensitivity, reason, payload
)
SELECT
  'merge:' || em.id::text || ':confirmed',
  em.workspace_id,
  COALESCE(em.merged_by, w.owner_user_id),
  'crm.entities_merged',
  1,
  'entity_merge',
  em.id::text,
  'entity',
  'workspace',
  CASE
    WHEN e_survivor.sensitivity = 'restricted' OR e_merged.sensitivity = 'restricted' THEN 'restricted'
    WHEN e_survivor.sensitivity = 'confidential' OR e_merged.sensitivity = 'confidential' THEN 'confidential'
    WHEN e_survivor.sensitivity = 'internal' OR e_merged.sensitivity = 'internal' THEN 'internal'
    ELSE 'public'
  END,
  LEFT(NULLIF(btrim(em.reason), ''), 1000),
  jsonb_build_object(
    'mergeId', em.id,
    'survivingEntityId', em.surviving_id,
    'mergedEntityId', em.merged_id,
    'bindingNamespaces', '[]'::jsonb
  )
FROM entity_merges em
JOIN workspaces w ON w.id = em.workspace_id
JOIN entities e_survivor ON e_survivor.id = em.surviving_id
JOIN entities e_merged ON e_merged.id = em.merged_id
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO decision_events (
  idempotency_key, workspace_id, actor_user_id, event_kind, schema_version,
  source_kind, source_id, declared_scope, visibility, sensitivity, reason,
  payload, reverses_event_id
)
SELECT
  'merge:' || em.id::text || ':undone',
  em.workspace_id,
  COALESCE(em.undone_by, em.merged_by, w.owner_user_id),
  'crm.merge_undone',
  1,
  'entity_merge',
  em.id::text,
  'entity',
  'workspace',
  original.sensitivity,
  LEFT(NULLIF(btrim(em.undo_reason), ''), 1000),
  jsonb_build_object(
    'mergeId', em.id,
    'survivingEntityId', em.surviving_id,
    'restoredEntityId', em.merged_id
  ),
  original.id
FROM entity_merges em
JOIN workspaces w ON w.id = em.workspace_id
JOIN decision_events original
  ON original.idempotency_key = 'merge:' || em.id::text || ':confirmed'
WHERE em.undone_at IS NOT NULL
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;
