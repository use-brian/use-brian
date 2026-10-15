-- Seller profiles, customer accounts, accepted commercial profile versions and
-- bounded operation versions with accepted instructions.
-- Spec: docs/architecture/features/crm-commercial-operations.md -> Commercial context.
-- [COMP:crm/commercial-context]
BEGIN;

CREATE TABLE crm_seller_profiles (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seller_key         TEXT NOT NULL CHECK(seller_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  legal_name         TEXT NOT NULL CHECK(length(btrim(legal_name)) BETWEEN 1 AND 300),
  display_name       TEXT NOT NULL CHECK(length(btrim(display_name)) BETWEEN 1 AND 300),
  company_id         UUID,
  timezone           TEXT NOT NULL DEFAULT 'UTC' CHECK(length(timezone) BETWEEN 1 AND 64),
  status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','archived')),
  user_id            UUID,
  assistant_id       UUID,
  sensitivity        TEXT NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),
  compartments       TEXT[] NOT NULL DEFAULT '{}',
  project_ids        UUID[] NOT NULL DEFAULT '{}',
  version            INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by_kind    TEXT NOT NULL,
  created_by_id      TEXT NOT NULL,
  created_by_user_id UUID,
  updated_by_kind    TEXT NOT NULL,
  updated_by_id      TEXT NOT NULL,
  updated_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,seller_key),
  UNIQUE(workspace_id,id)
);

CREATE TABLE crm_customer_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seller_id          UUID NOT NULL,
  company_id         UUID NOT NULL,
  label              TEXT NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 300),
  billing_contact_id UUID,
  billing_address    TEXT CHECK(billing_address IS NULL OR length(billing_address) BETWEEN 1 AND 2000),
  status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','archived')),
  user_id            UUID,
  assistant_id       UUID,
  sensitivity        TEXT NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),
  compartments       TEXT[] NOT NULL DEFAULT '{}',
  project_ids        UUID[] NOT NULL DEFAULT '{}',
  version            INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by_kind    TEXT NOT NULL,
  created_by_id      TEXT NOT NULL,
  created_by_user_id UUID,
  updated_by_kind    TEXT NOT NULL,
  updated_by_id      TEXT NOT NULL,
  updated_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,seller_id) REFERENCES crm_seller_profiles(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX crm_customer_accounts_company ON crm_customer_accounts(workspace_id,company_id,created_at,id);
CREATE INDEX crm_customer_accounts_contact ON crm_customer_accounts(workspace_id,billing_contact_id) WHERE billing_contact_id IS NOT NULL;

CREATE TABLE crm_commercial_profile_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_kind          TEXT NOT NULL CHECK(owner_kind IN('seller','account','agreement')),
  seller_id           UUID,
  account_id          UUID,
  agreement_key       TEXT CHECK(agreement_key IS NULL OR agreement_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  owner_key           TEXT NOT NULL CHECK(length(owner_key) BETWEEN 1 AND 200),
  deal_ids            UUID[] NOT NULL DEFAULT '{}' CHECK(cardinality(deal_ids)<=50),
  version             INTEGER NOT NULL CHECK(version>=1),
  status              TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN('accepted','superseded')),
  fields              JSONB NOT NULL CHECK(jsonb_typeof(fields)='object'),
  effective_from      DATE,
  effective_to        DATE,
  evidence            JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  user_id             UUID,
  assistant_id        UUID,
  sensitivity         TEXT NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),
  compartments        TEXT[] NOT NULL DEFAULT '{}',
  project_ids         UUID[] NOT NULL DEFAULT '{}',
  operation_id        UUID NOT NULL,
  accepted_by_kind    TEXT NOT NULL,
  accepted_by_id      TEXT NOT NULL,
  accepted_by_user_id UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at       TIMESTAMPTZ,
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,owner_key,version),
  FOREIGN KEY(workspace_id,seller_id) REFERENCES crm_seller_profiles(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,account_id) REFERENCES crm_customer_accounts(workspace_id,id) ON DELETE CASCADE,
  CHECK((owner_kind='seller')=(seller_id IS NOT NULL AND account_id IS NULL AND agreement_key IS NULL)),
  CHECK(owner_kind='seller' OR (account_id IS NOT NULL AND seller_id IS NULL)),
  CHECK((owner_kind='agreement')=(agreement_key IS NOT NULL)),
  CHECK(effective_from IS NULL OR effective_to IS NULL OR effective_from<=effective_to)
);
CREATE UNIQUE INDEX crm_commercial_profile_current ON crm_commercial_profile_versions(workspace_id,owner_key) WHERE status='accepted';

CREATE TABLE crm_operation_definitions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_key      TEXT NOT NULL CHECK(operation_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  operation_kind     TEXT NOT NULL CHECK(operation_kind IN('invoice','proposal')),
  label              TEXT NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 200),
  current_version_id UUID,
  status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','archived')),
  version            INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by_kind    TEXT NOT NULL,
  created_by_id      TEXT NOT NULL,
  created_by_user_id UUID,
  updated_by_kind    TEXT NOT NULL,
  updated_by_id      TEXT NOT NULL,
  updated_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,operation_key),
  UNIQUE(workspace_id,id)
);

CREATE TABLE crm_operation_versions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_id            UUID NOT NULL,
  version_number           INTEGER NOT NULL CHECK(version_number>=1),
  state                    TEXT NOT NULL DEFAULT 'proposed' CHECK(state IN('proposed','accepted','superseded','withdrawn')),
  instructions             TEXT NOT NULL CHECK(length(instructions) BETWEEN 1 AND 20000),
  instruction_source       JSONB CHECK(instruction_source IS NULL OR jsonb_typeof(instruction_source)='object'),
  field_bindings           JSONB NOT NULL CHECK(jsonb_typeof(field_bindings)='array' AND jsonb_array_length(field_bindings) BETWEEN 1 AND 200),
  template_binding         JSONB CHECK(template_binding IS NULL OR jsonb_typeof(template_binding)='object'),
  review_policy            TEXT NOT NULL CHECK(review_policy IN('direct','exact_version_review')),
  reference_definition_key TEXT,
  config_hash              TEXT NOT NULL CHECK(config_hash ~ '^[0-9a-f]{64}$'),
  operation_id             UUID NOT NULL,
  proposed_by_kind         TEXT NOT NULL,
  proposed_by_id           TEXT NOT NULL,
  proposed_by_user_id      UUID,
  accepted_by_kind         TEXT,
  accepted_by_id           TEXT,
  accepted_by_user_id      UUID,
  accepted_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,definition_id,version_number),
  FOREIGN KEY(workspace_id,definition_id) REFERENCES crm_operation_definitions(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX crm_operation_versions_current ON crm_operation_versions(workspace_id,definition_id) WHERE state='accepted';
ALTER TABLE crm_operation_definitions ADD FOREIGN KEY(workspace_id,current_version_id)
  REFERENCES crm_operation_versions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

-- Accepted content is a snapshot: only lifecycle columns may change.
CREATE FUNCTION public.crm_operation_version_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.definition_id,NEW.version_number,NEW.instructions,NEW.instruction_source,
         NEW.field_bindings,NEW.template_binding,NEW.review_policy,NEW.reference_definition_key,NEW.config_hash,
         NEW.operation_id,NEW.proposed_by_kind,NEW.proposed_by_id,NEW.proposed_by_user_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.workspace_id,OLD.definition_id,OLD.version_number,OLD.instructions,OLD.instruction_source,
         OLD.field_bindings,OLD.template_binding,OLD.review_policy,OLD.reference_definition_key,OLD.config_hash,
         OLD.operation_id,OLD.proposed_by_kind,OLD.proposed_by_id,OLD.proposed_by_user_id,OLD.created_at)
     OR NOT(OLD.state=NEW.state OR (OLD.state='proposed' AND NEW.state IN('accepted','withdrawn')) OR (OLD.state='accepted' AND NEW.state='superseded')) THEN
    RAISE EXCEPTION 'crm_operation_version_snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_operation_version_snapshot BEFORE UPDATE ON crm_operation_versions
  FOR EACH ROW EXECUTE FUNCTION public.crm_operation_version_snapshot();

CREATE FUNCTION public.crm_commercial_profile_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.owner_kind,NEW.seller_id,NEW.account_id,NEW.agreement_key,NEW.owner_key,NEW.deal_ids,
         NEW.version,NEW.fields,NEW.effective_from,NEW.effective_to,NEW.evidence,NEW.operation_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.workspace_id,OLD.owner_kind,OLD.seller_id,OLD.account_id,OLD.agreement_key,OLD.owner_key,OLD.deal_ids,
         OLD.version,OLD.fields,OLD.effective_from,OLD.effective_to,OLD.evidence,OLD.operation_id,OLD.created_at)
     OR NOT(OLD.status=NEW.status OR (OLD.status='accepted' AND NEW.status='superseded')) THEN
    RAISE EXCEPTION 'crm_commercial_profile_snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_commercial_profile_snapshot BEFORE UPDATE ON crm_commercial_profile_versions
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_profile_snapshot();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['crm_seller_profiles','crm_customer_accounts','crm_commercial_profile_versions',
    'crm_operation_definitions','crm_operation_versions'] LOOP
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
  'crm.commercial.read','crm.commercial.write','crm.commercial.configure'));

SELECT public.crm_install_erasure_capture();

COMMIT;
