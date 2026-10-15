-- ERP bridge: provider bindings and writer ownership, legacy identity
-- mappings (records and enrolled viewers), staged imports with
-- reconciliation, a versioned projection log for retained domain
-- applications, consumer receipts and explicit cutover runs.
-- Spec: docs/architecture/features/crm-commercial-operations.md -> ERP bridge.
-- [COMP:crm/erp-bridge]
BEGIN;

CREATE TABLE crm_provider_bindings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  binding_key               TEXT NOT NULL CHECK(binding_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  label                     TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
  integration_credential_id UUID,
  -- legacy: the external application still writes the migrated classes;
  -- frozen: a cutover is prepared and legacy writes are refused;
  -- brian: the cutover committed and the CRM is the only writer.
  writer_state              TEXT NOT NULL DEFAULT 'legacy' CHECK(writer_state IN('legacy','frozen','brian')),
  record_classes            TEXT[] NOT NULL DEFAULT '{client,engagement}',
  reference_definitions     JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(reference_definitions)='object'),
  version                   INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by_kind           TEXT NOT NULL,
  created_by_id             TEXT NOT NULL,
  created_by_user_id        UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,binding_key)
);

CREATE TABLE crm_legacy_id_mappings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  binding_id     UUID NOT NULL,
  legacy_type    TEXT NOT NULL CHECK(legacy_type IN('client','engagement','viewer')),
  legacy_id      TEXT NOT NULL CHECK(length(legacy_id) BETWEEN 1 AND 200),
  target_kind    TEXT NOT NULL CHECK(target_kind IN('company','deal','user')),
  target_id      UUID NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','tombstoned')),
  import_id      UUID,
  created_by_kind TEXT NOT NULL,
  created_by_id  TEXT NOT NULL,
  created_by_user_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  -- One legacy record maps to one canonical target, and a target to one legacy record per binding.
  UNIQUE(binding_id,legacy_type,legacy_id),
  FOREIGN KEY(workspace_id,binding_id) REFERENCES crm_provider_bindings(workspace_id,id) ON DELETE CASCADE,
  CHECK((legacy_type='viewer')=(target_kind='user'))
);
CREATE UNIQUE INDEX crm_legacy_id_mappings_target ON crm_legacy_id_mappings(binding_id,legacy_type,target_id) WHERE status='active';

CREATE TABLE crm_erp_imports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  binding_id     UUID NOT NULL,
  state          TEXT NOT NULL DEFAULT 'staged' CHECK(state IN('staged','confirmed','superseded')),
  records        JSONB NOT NULL CHECK(jsonb_typeof(records)='object'),
  records_hash   TEXT NOT NULL CHECK(records_hash ~ '^[0-9a-f]{64}$'),
  report         JSONB NOT NULL CHECK(jsonb_typeof(report)='object'),
  report_hash    TEXT NOT NULL CHECK(report_hash ~ '^[0-9a-f]{64}$'),
  outcome        JSONB CHECK(outcome IS NULL OR jsonb_typeof(outcome)='object'),
  version        INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  staged_by_kind TEXT NOT NULL,
  staged_by_id   TEXT NOT NULL,
  staged_by_user_id UUID,
  confirmed_by_kind TEXT,
  confirmed_by_id TEXT,
  confirmed_by_user_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at   TIMESTAMPTZ,
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,binding_id) REFERENCES crm_provider_bindings(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX crm_erp_imports_binding ON crm_erp_imports(workspace_id,binding_id,created_at);

-- Versioned changes to companies and deals for retained domain applications
-- (timesheets, scheduling). Rows carry identity and version only; the
-- projection itself is read live under the reader's current access.
CREATE TABLE crm_projection_events (
  seq          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN('company','deal')),
  subject_id   UUID NOT NULL,
  version      INTEGER NOT NULL CHECK(version>=1),
  tombstone    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,subject_id,version)
);
CREATE INDEX crm_projection_events_feed ON crm_projection_events(workspace_id,seq);

CREATE TABLE crm_projection_receipts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  binding_id   UUID NOT NULL,
  event_seq    BIGINT,
  subject_id   UUID NOT NULL,
  version      INTEGER NOT NULL CHECK(version>=1),
  outcome      TEXT NOT NULL CHECK(outcome IN('applied','resynced')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,binding_id) REFERENCES crm_provider_bindings(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX crm_projection_receipts_event ON crm_projection_receipts(binding_id,event_seq) WHERE event_seq IS NOT NULL;
CREATE INDEX crm_projection_receipts_subject ON crm_projection_receipts(binding_id,subject_id,version);

CREATE TABLE crm_cutover_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  binding_id     UUID NOT NULL,
  state          TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','committed','abandoned')),
  record_classes TEXT[] NOT NULL,
  source         JSONB NOT NULL CHECK(jsonb_typeof(source)='object'),
  reconciliation JSONB NOT NULL CHECK(jsonb_typeof(reconciliation)='object'),
  final_delta    JSONB CHECK(final_delta IS NULL OR jsonb_typeof(final_delta)='object'),
  last_import_id UUID,
  version        INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  prepared_by_kind TEXT NOT NULL,
  prepared_by_id TEXT NOT NULL,
  prepared_by_user_id UUID,
  committed_by_kind TEXT,
  committed_by_id TEXT,
  committed_by_user_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at   TIMESTAMPTZ,
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,binding_id) REFERENCES crm_provider_bindings(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX crm_cutover_runs_open ON crm_cutover_runs(binding_id) WHERE state='prepared';

-- Append the next projection version for a company or deal, only in
-- workspaces with a provider binding. Serialized per subject.
CREATE FUNCTION public.crm_projection_append(w uuid,k text,s uuid,gone boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM crm_provider_bindings WHERE workspace_id=w) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-projection:'||s::text,0));
  INSERT INTO crm_projection_events(workspace_id,subject_kind,subject_id,version,tombstone)
    SELECT w,k,s,coalesce(max(version),0)+1,gone FROM crm_projection_events WHERE workspace_id=w AND subject_id=s;
END;
$$;
REVOKE ALL ON FUNCTION public.crm_projection_append(uuid,text,uuid,boolean) FROM PUBLIC;

CREATE FUNCTION public.crm_projection_from_entity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.crm_projection_append(NEW.workspace_id,NEW.kind,NEW.id,
    NEW.valid_to IS NOT NULL OR NEW.retracted_at IS NOT NULL);
  RETURN NULL;
END;
$$;
CREATE TRIGGER crm_projection_entity_insert AFTER INSERT ON entities
  FOR EACH ROW WHEN (NEW.kind IN('company','deal')) EXECUTE FUNCTION public.crm_projection_from_entity();
CREATE TRIGGER crm_projection_entity_update AFTER UPDATE ON entities
  FOR EACH ROW WHEN (NEW.kind IN('company','deal') AND (OLD.display_name IS DISTINCT FROM NEW.display_name
    OR OLD.attributes IS DISTINCT FROM NEW.attributes OR OLD.valid_to IS DISTINCT FROM NEW.valid_to
    OR OLD.retracted_at IS DISTINCT FROM NEW.retracted_at OR OLD.sensitivity IS DISTINCT FROM NEW.sensitivity
    OR OLD.compartments IS DISTINCT FROM NEW.compartments OR OLD.project_ids IS DISTINCT FROM NEW.project_ids))
  EXECUTE FUNCTION public.crm_projection_from_entity();

CREATE FUNCTION public.crm_projection_from_engagement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.crm_projection_append(NEW.workspace_id,'deal',NEW.deal_id,false);
  RETURN NULL;
END;
$$;
CREATE TRIGGER crm_projection_engagement AFTER INSERT OR UPDATE ON crm_engagement_extensions
  FOR EACH ROW EXECUTE FUNCTION public.crm_projection_from_engagement();

-- A recode or retirement changes the subject's printable codes.
CREATE FUNCTION public.crm_projection_from_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.target_kind IN('company','deal') THEN
    PERFORM public.crm_projection_append(NEW.workspace_id,NEW.target_kind,NEW.target_id,false);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER crm_projection_reference AFTER INSERT OR UPDATE ON crm_business_references
  FOR EACH ROW EXECUTE FUNCTION public.crm_projection_from_reference();

CREATE TRIGGER crm_projection_events_append_only BEFORE UPDATE ON crm_projection_events
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_append_only();
CREATE TRIGGER crm_projection_receipts_append_only BEFORE UPDATE ON crm_projection_receipts
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_append_only();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['crm_provider_bindings','crm_legacy_id_mappings','crm_erp_imports','crm_projection_events',
    'crm_projection_receipts','crm_cutover_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT USING(workspace_id IN(SELECT workspace_id FROM workspace_members
      WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid))$p$,table_name||'_member_read',table_name);
    EXECUTE format($p$CREATE POLICY %I ON public.%I USING(current_setting('app.system_bypass',true)='true')
      WITH CHECK(current_setting('app.system_bypass',true)='true')$p$,table_name||'_system',table_name);
    EXECUTE format('CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write()',table_name);
  END LOOP;
END;
$$;

ALTER TABLE crm_integration_credential_grants DROP CONSTRAINT crm_integration_credential_grants_operation_check;
ALTER TABLE crm_integration_credential_grants ADD CONSTRAINT crm_integration_credential_grants_operation_check CHECK (operation IN (
  'crm.records.read','crm.records.write','crm.catalog.read','crm.catalog.configure',
  'crm.submissions.read','crm.submissions.write','crm.consent.read','crm.consent.write',
  'crm.entitlements.read','crm.entitlements.write','crm.participation.read','crm.participation.write',
  'crm.imports.read','crm.imports.write','crm.audit.read','crm.privacy.export','crm.privacy.retention',
  'crm.delivery.read','crm.delivery.dispatch','association.read','association.orders.write',
  'association.provider_events.write','crm.references.read','crm.references.write','crm.references.configure',
  'crm.commercial.read','crm.commercial.write','crm.commercial.configure','crm.commercial.issue',
  'crm.changes.read','crm.changes.write','crm.changes.review','crm.engagements.read','crm.engagements.write',
  'crm.billing.read','crm.billing.write','crm.billing.review',
  'crm.projections.read','crm.projections.write','crm.cutovers.configure'));

SELECT public.crm_install_erasure_capture();

COMMIT;
