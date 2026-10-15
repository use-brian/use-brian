-- Governed client/engagement operations: review policies, catalogs, change
-- requests with immutable revisions and decisions, engagement extensions,
-- protected commercial values and billing requests.
-- Spec: docs/architecture/features/crm-commercial-operations.md -> Governed engagement and billing.
-- [COMP:crm/governed-records]
BEGIN;

CREATE TABLE crm_governance_policies (
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject         TEXT NOT NULL CHECK(subject IN('client_change','engagement_change','commercial_values','billing_request')),
  policy          JSONB NOT NULL CHECK(jsonb_typeof(policy)='object'),
  version         INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  updated_by_kind TEXT NOT NULL,
  updated_by_id   TEXT NOT NULL,
  updated_by_user_id UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,subject)
);

CREATE TABLE crm_engagement_catalogs (
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  catalog         TEXT NOT NULL CHECK(catalog IN('service_category','work_status')),
  entries         JSONB NOT NULL CHECK(jsonb_typeof(entries)='array'),
  version         INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  updated_by_kind TEXT NOT NULL,
  updated_by_id   TEXT NOT NULL,
  updated_by_user_id UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,catalog)
);

CREATE TABLE crm_change_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_kind        TEXT NOT NULL CHECK(target_kind IN('company','deal')),
  target_id          UUID,
  applied_target_id  UUID,
  policy_subject     TEXT NOT NULL CHECK(policy_subject IN('client_change','engagement_change')),
  state              TEXT NOT NULL DEFAULT 'draft' CHECK(state IN('draft','submitted','returned','approved','rejected','withdrawn')),
  revision           INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  draft_changes      JSONB NOT NULL CHECK(jsonb_typeof(draft_changes)='object'),
  note               TEXT CHECK(note IS NULL OR length(note)<=2000),
  user_id            UUID,
  assistant_id       UUID,
  sensitivity        TEXT NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),
  compartments       TEXT[] NOT NULL DEFAULT '{}',
  project_ids        UUID[] NOT NULL DEFAULT '{}',
  author_kind        TEXT NOT NULL,
  author_id          TEXT NOT NULL,
  author_user_id     UUID,
  version            INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id)
);
CREATE INDEX crm_change_requests_queue ON crm_change_requests(workspace_id,state,created_at,id);

CREATE TABLE crm_change_request_revisions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id       UUID NOT NULL,
  revision         INTEGER NOT NULL CHECK(revision>=1),
  changes          JSONB NOT NULL CHECK(jsonb_typeof(changes)='object'),
  current_snapshot JSONB NOT NULL CHECK(jsonb_typeof(current_snapshot)='object'),
  base_versions    JSONB NOT NULL CHECK(jsonb_typeof(base_versions)='object'),
  policy           JSONB NOT NULL CHECK(jsonb_typeof(policy)='object'),
  policy_version   INTEGER NOT NULL,
  payload_hash     TEXT NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  actor_kind       TEXT NOT NULL,
  actor_id         TEXT NOT NULL,
  actor_user_id    UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,request_id,revision),
  FOREIGN KEY(workspace_id,request_id) REFERENCES crm_change_requests(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE crm_change_request_decisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id     UUID NOT NULL,
  revision       INTEGER NOT NULL CHECK(revision>=0),
  decision       TEXT NOT NULL CHECK(decision IN('approved','returned','rejected','withdrawn','applied_direct')),
  reason         TEXT CHECK(reason IS NULL OR length(reason)<=2000),
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_user_id  UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,request_id) REFERENCES crm_change_requests(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX crm_change_request_decisions_once ON crm_change_request_decisions(workspace_id,request_id,revision)
  WHERE decision IN('approved','rejected','applied_direct');

CREATE TABLE crm_engagement_extensions (
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id                   UUID NOT NULL,
  service_category          TEXT,
  period_start              DATE,
  period_end                DATE,
  financial_period          TEXT CHECK(financial_period IS NULL OR length(financial_period) BETWEEN 1 AND 40),
  work_status               TEXT,
  deadline                  DATE,
  owner_user_id             UUID,
  participant_ids           UUID[] NOT NULL DEFAULT '{}' CHECK(cardinality(participant_ids)<=100),
  recurrence_parent_deal_id UUID,
  recurrence_period_key     TEXT CHECK(recurrence_period_key IS NULL OR length(recurrence_period_key) BETWEEN 1 AND 40),
  version                   INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,deal_id),
  CHECK((recurrence_parent_deal_id IS NULL)=(recurrence_period_key IS NULL)),
  CHECK(period_start IS NULL OR period_end IS NULL OR period_start<=period_end)
);
-- Each source creates at most one successor per period.
CREATE UNIQUE INDEX crm_engagement_successor_once ON crm_engagement_extensions(workspace_id,recurrence_parent_deal_id,recurrence_period_key)
  WHERE recurrence_parent_deal_id IS NOT NULL;

CREATE TABLE crm_commercial_values (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id        UUID NOT NULL,
  value_kind     TEXT NOT NULL CHECK(value_kind IN('quoted','confirmed','outsource')),
  version        INTEGER NOT NULL CHECK(version>=1),
  status         TEXT NOT NULL DEFAULT 'current' CHECK(status IN('current','superseded')),
  amount         NUMERIC(24,6),
  currency       TEXT NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  rate           JSONB CHECK(rate IS NULL OR jsonb_typeof(rate)='object'),
  evidence       JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  operation_id   UUID NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_user_id  UUID,
  user_id        UUID,
  assistant_id   UUID,
  sensitivity    TEXT NOT NULL DEFAULT 'confidential' CHECK(sensitivity IN('public','internal','confidential')),
  compartments   TEXT[] NOT NULL DEFAULT '{}',
  project_ids    UUID[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,deal_id,value_kind,version)
);
CREATE UNIQUE INDEX crm_commercial_values_current ON crm_commercial_values(workspace_id,deal_id,value_kind) WHERE status='current';

CREATE TABLE crm_billing_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id          UUID NOT NULL,
  state            TEXT NOT NULL CHECK(state IN('draft','review','ready_to_bill','invoiced','returned','cancelled')),
  amount           NUMERIC(24,6) NOT NULL,
  currency         TEXT NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  description      TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  reviewed_values  JSONB CHECK(reviewed_values IS NULL OR jsonb_typeof(reviewed_values)='object'),
  review_step      TEXT CHECK(review_step IS NULL OR review_step IN('reviewer','finance')),
  reviewed_by_user_id UUID,
  reviewed_at      TIMESTAMPTZ,
  finance_by_user_id UUID,
  finance_at       TIMESTAMPTZ,
  invoice_id       UUID,
  return_reason    TEXT CHECK(return_reason IS NULL OR length(return_reason)<=2000),
  author_kind      TEXT NOT NULL,
  author_id        TEXT NOT NULL,
  author_user_id   UUID,
  user_id          UUID,
  assistant_id     UUID,
  sensitivity      TEXT NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),
  compartments     TEXT[] NOT NULL DEFAULT '{}',
  project_ids      UUID[] NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,invoice_id) REFERENCES crm_invoices(workspace_id,id),
  CHECK((state='invoiced')=(invoice_id IS NOT NULL)),
  CHECK((state='review')=(review_step IS NOT NULL))
);
CREATE INDEX crm_billing_requests_queue ON crm_billing_requests(workspace_id,state,created_at,id);

ALTER TABLE crm_invoice_allocations ADD COLUMN billing_request_id UUID;
ALTER TABLE crm_invoice_allocations ADD FOREIGN KEY(workspace_id,billing_request_id) REFERENCES crm_billing_requests(workspace_id,id);
CREATE UNIQUE INDEX crm_invoice_allocations_request ON crm_invoice_allocations(workspace_id,billing_request_id) WHERE billing_request_id IS NOT NULL;

CREATE TRIGGER crm_change_request_revisions_append_only BEFORE UPDATE ON crm_change_request_revisions
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_append_only();
CREATE TRIGGER crm_change_request_decisions_append_only BEFORE UPDATE ON crm_change_request_decisions
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_append_only();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['crm_governance_policies','crm_engagement_catalogs','crm_change_requests','crm_change_request_revisions',
    'crm_change_request_decisions','crm_engagement_extensions','crm_commercial_values','crm_billing_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT USING(workspace_id IN(SELECT workspace_id FROM workspace_members
      WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid))$p$,table_name||'_member_read',table_name);
    EXECUTE format($p$CREATE POLICY %I ON public.%I USING(current_setting('app.system_bypass',true)='true')
      WITH CHECK(current_setting('app.system_bypass',true)='true')$p$,table_name||'_system',table_name);
    EXECUTE format('CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write()',table_name);
  END LOOP;
END;
$$;

ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT crm_domain_event_outbox_event_type_check;
ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_event_type_check CHECK(event_type IN(
  'crm.submission.received','crm.submission.updated','crm.consent.changed','crm.suppression.changed','crm.entitlement.changed',
  'crm.participation.changed','crm.deal.stage_changed','association.inventory.sold_out','association.inventory.available',
  'crm.reference.assigned','crm.reference.replaced','crm.reference.retired',
  'crm.change_request.submitted','crm.change_request.decided'));

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
  'crm.billing.read','crm.billing.write','crm.billing.review'));

SELECT public.crm_install_erasure_capture();

COMMIT;
