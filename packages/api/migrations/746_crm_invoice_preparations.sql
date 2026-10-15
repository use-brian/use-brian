-- Commercial document preparation, typed invoices, allocations and durable
-- issue attempts (the committed render/release outbox).
-- Spec: docs/architecture/features/crm-commercial-operations.md -> Invoice preparation.
-- [COMP:crm/invoice-preparation]
BEGIN;

CREATE TABLE crm_commercial_preparations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_definition_id UUID NOT NULL,
  operation_version_id    UUID NOT NULL,
  operation_kind          TEXT NOT NULL CHECK(operation_kind IN('invoice','proposal')),
  account_id              UUID NOT NULL,
  seller_id               UUID NOT NULL,
  title                   TEXT NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300),
  state                   TEXT NOT NULL DEFAULT 'draft' CHECK(state IN('draft','ready','issue_pending','issue_failed','issued','voided')),
  version                 INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  ready_version           INTEGER,
  ready_by_kind           TEXT,
  ready_by_id             TEXT,
  ready_by_user_id        UUID,
  ready_at                TIMESTAMPTZ,
  office_artifact_id      UUID,
  office_version          INTEGER,
  office_binding          JSONB CHECK(office_binding IS NULL OR jsonb_typeof(office_binding)='object'),
  draft_render_error      TEXT CHECK(draft_render_error IS NULL OR length(draft_render_error)<=500),
  user_id                 UUID,
  assistant_id            UUID,
  sensitivity             TEXT NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),
  compartments            TEXT[] NOT NULL DEFAULT '{}',
  project_ids             UUID[] NOT NULL DEFAULT '{}',
  created_by_kind         TEXT NOT NULL,
  created_by_id           TEXT NOT NULL,
  created_by_user_id      UUID,
  updated_by_kind         TEXT NOT NULL,
  updated_by_id           TEXT NOT NULL,
  updated_by_user_id      UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,operation_definition_id) REFERENCES crm_operation_definitions(workspace_id,id),
  FOREIGN KEY(workspace_id,operation_version_id) REFERENCES crm_operation_versions(workspace_id,id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES crm_customer_accounts(workspace_id,id),
  FOREIGN KEY(workspace_id,seller_id) REFERENCES crm_seller_profiles(workspace_id,id),
  CHECK(ready_version IS NULL OR ready_version<=version)
);
CREATE INDEX crm_commercial_preparations_account ON crm_commercial_preparations(workspace_id,account_id,created_at,id);

CREATE TABLE crm_preparation_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  preparation_id  UUID NOT NULL,
  version         INTEGER NOT NULL CHECK(version>=1),
  content         JSONB NOT NULL CHECK(jsonb_typeof(content)='object'),
  resolution      JSONB NOT NULL CHECK(jsonb_typeof(resolution)='object'),
  totals          JSONB CHECK(totals IS NULL OR jsonb_typeof(totals)='object'),
  questions       JSONB NOT NULL CHECK(jsonb_typeof(questions)='array'),
  draft_ready     BOOLEAN NOT NULL,
  issue_ready     BOOLEAN NOT NULL,
  source_hash     TEXT NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  content_hash    TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  operation_id    UUID NOT NULL,
  actor_kind      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  actor_user_id   UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,preparation_id,version),
  FOREIGN KEY(workspace_id,preparation_id) REFERENCES crm_commercial_preparations(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE crm_invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  origin             TEXT NOT NULL CHECK(origin IN('native','external')),
  preparation_id     UUID UNIQUE,
  seller_id          UUID NOT NULL,
  account_id         UUID NOT NULL,
  state              TEXT NOT NULL CHECK(state IN('draft','ready','issue_pending','issue_failed','issued','voided')),
  number             TEXT CHECK(number IS NULL OR length(number) BETWEEN 1 AND 128),
  reference_id       UUID,
  issue_date         DATE,
  currency           TEXT CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  minor_units        SMALLINT CHECK(minor_units IS NULL OR minor_units BETWEEN 0 AND 4),
  subtotal           NUMERIC(24,6),
  tax_rate           NUMERIC(9,6) CHECK(tax_rate IS NULL OR (tax_rate>=0 AND tax_rate<=1)),
  tax_amount         NUMERIC(24,6),
  total              NUMERIC(24,6),
  frozen_payload     JSONB CHECK(frozen_payload IS NULL OR jsonb_typeof(frozen_payload)='object'),
  frozen_hash        TEXT CHECK(frozen_hash IS NULL OR frozen_hash ~ '^[0-9a-f]{64}$'),
  external_provider  TEXT,
  external_remote_id TEXT,
  office_artifact_id UUID,
  office_version     INTEGER,
  xlsx_release_id    UUID,
  xlsx_file_id       UUID,
  xlsx_sha256        TEXT,
  pdf_release_id     UUID,
  pdf_file_id        UUID,
  pdf_sha256         TEXT,
  pdf_page_count     INTEGER,
  issued_at          TIMESTAMPTZ,
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT CHECK(void_reason IS NULL OR length(void_reason) BETWEEN 1 AND 2000),
  user_id            UUID,
  assistant_id       UUID,
  sensitivity        TEXT NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),
  compartments       TEXT[] NOT NULL DEFAULT '{}',
  project_ids        UUID[] NOT NULL DEFAULT '{}',
  version            INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,preparation_id) REFERENCES crm_commercial_preparations(workspace_id,id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES crm_customer_accounts(workspace_id,id),
  FOREIGN KEY(workspace_id,seller_id) REFERENCES crm_seller_profiles(workspace_id,id),
  FOREIGN KEY(workspace_id,reference_id) REFERENCES crm_business_references(workspace_id,id),
  CHECK((origin='native')=(preparation_id IS NOT NULL)),
  CHECK(origin='native' OR (external_provider IS NOT NULL AND external_remote_id IS NOT NULL)),
  CHECK(state NOT IN('issue_pending','issue_failed','issued','voided') OR (number IS NOT NULL AND issue_date IS NOT NULL AND frozen_hash IS NOT NULL) OR origin='external')
);
CREATE UNIQUE INDEX crm_invoices_external ON crm_invoices(workspace_id,external_provider,external_remote_id) WHERE origin='external';
CREATE INDEX crm_invoices_account ON crm_invoices(workspace_id,account_id,created_at,id);

-- Issued commercial identity is immutable; voiding keeps number and payload.
CREATE FUNCTION public.crm_invoice_issued_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.frozen_hash IS NOT NULL AND ROW(NEW.number,NEW.reference_id,NEW.issue_date,NEW.currency,NEW.subtotal,NEW.tax_rate,NEW.tax_amount,
       NEW.total,NEW.frozen_payload,NEW.frozen_hash,NEW.seller_id,NEW.account_id,NEW.preparation_id)
     IS DISTINCT FROM ROW(OLD.number,OLD.reference_id,OLD.issue_date,OLD.currency,OLD.subtotal,OLD.tax_rate,OLD.tax_amount,
       OLD.total,OLD.frozen_payload,OLD.frozen_hash,OLD.seller_id,OLD.account_id,OLD.preparation_id) THEN
    RAISE EXCEPTION 'crm_invoice_issued_immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state IN('issued','voided') AND NEW.state<>OLD.state AND NOT(OLD.state='issued' AND NEW.state='voided') THEN
    RAISE EXCEPTION 'crm_invoice_transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_invoice_issued_immutable BEFORE UPDATE ON crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.crm_invoice_issued_immutable();

CREATE TABLE crm_invoice_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_id   UUID NOT NULL,
  position     INTEGER NOT NULL CHECK(position BETWEEN 1 AND 30),
  description  TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 500),
  quantity     NUMERIC(24,6) NOT NULL,
  unit_price   NUMERIC(24,6) NOT NULL,
  amount       NUMERIC(24,6) NOT NULL,
  deal_id      UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,invoice_id,position),
  FOREIGN KEY(workspace_id,invoice_id) REFERENCES crm_invoices(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE crm_invoice_allocations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_id   UUID NOT NULL,
  deal_id      UUID NOT NULL,
  amount       NUMERIC(24,6) NOT NULL,
  currency     TEXT NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,invoice_id,deal_id),
  FOREIGN KEY(workspace_id,invoice_id) REFERENCES crm_invoices(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX crm_invoice_allocations_deal ON crm_invoice_allocations(workspace_id,deal_id);

CREATE TABLE crm_issue_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL,
  attempt          INTEGER NOT NULL CHECK(attempt>=1),
  state            TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','failed','succeeded')),
  operation_id     UUID NOT NULL,
  render_user_id   UUID NOT NULL,
  lease_token      UUID,
  lease_expires_at TIMESTAMPTZ,
  error_code       TEXT CHECK(error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.]{0,80}$'),
  error_detail     TEXT CHECK(error_detail IS NULL OR length(error_detail)<=500),
  office_version   INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,invoice_id,attempt),
  FOREIGN KEY(workspace_id,invoice_id) REFERENCES crm_invoices(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX crm_issue_attempts_open ON crm_issue_attempts(workspace_id,invoice_id) WHERE state IN('pending','running');
CREATE INDEX crm_issue_attempts_due ON crm_issue_attempts(state,created_at) WHERE state IN('pending','running');

CREATE TRIGGER crm_preparation_versions_append_only BEFORE UPDATE ON crm_preparation_versions
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_append_only();
CREATE TRIGGER crm_invoice_lines_append_only BEFORE UPDATE ON crm_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_append_only();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['crm_commercial_preparations','crm_preparation_versions','crm_invoices',
    'crm_invoice_lines','crm_invoice_allocations','crm_issue_attempts'] LOOP
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
  'crm.commercial.read','crm.commercial.write','crm.commercial.configure','crm.commercial.issue'));

SELECT public.crm_install_erasure_capture();

COMMIT;
