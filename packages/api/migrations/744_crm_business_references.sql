-- Business reference definitions, native numbering and the operation receipt
-- registry. Spec: docs/architecture/features/crm-commercial-operations.md.
-- [COMP:crm/business-references]
BEGIN;

CREATE TABLE crm_reference_definitions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_key     TEXT NOT NULL CHECK(definition_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  label              TEXT NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 200),
  target_kinds       TEXT[] NOT NULL CHECK(cardinality(target_kinds) BETWEEN 1 AND 4
                       AND target_kinds <@ ARRAY['company','deal','account','invoice']::text[]),
  assignment_mode    TEXT NOT NULL CHECK(assignment_mode IN('native','manual','external')),
  namespace_key      TEXT NOT NULL CHECK(namespace_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  format             JSONB CHECK(format IS NULL OR jsonb_typeof(format)='array'),
  partition_dimensions TEXT[] NOT NULL DEFAULT '{}'
                       CHECK(partition_dimensions <@ ARRAY['business_year','parent_target','service_category']::text[]),
  categories         JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(categories)='array'),
  timezone           TEXT NOT NULL DEFAULT 'UTC' CHECK(length(timezone) BETWEEN 1 AND 64),
  assignment_event   TEXT NOT NULL CHECK(assignment_event IN('explicit','approval','issue')),
  change_policy      TEXT NOT NULL CHECK(change_policy IN('immutable','correctable')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN('draft','active','archived')),
  version            INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by_kind    TEXT NOT NULL,
  created_by_id      TEXT NOT NULL,
  created_by_user_id UUID,
  updated_by_kind    TEXT NOT NULL,
  updated_by_id      TEXT NOT NULL,
  updated_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,definition_key),
  UNIQUE(workspace_id,namespace_key),
  UNIQUE(workspace_id,id),
  CHECK(assignment_mode<>'native' OR format IS NOT NULL)
);

CREATE TABLE crm_number_series (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_id        UUID NOT NULL,
  counter_start        BIGINT NOT NULL DEFAULT 1 CHECK(counter_start BETWEEN 0 AND 999999999999),
  counter_width        SMALLINT NOT NULL CHECK(counter_width BETWEEN 1 AND 12),
  partition_dimensions TEXT[] NOT NULL DEFAULT '{}',
  config_version       INTEGER NOT NULL CHECK(config_version>=1),
  state                TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','retired')),
  version              INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,definition_id),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,definition_id) REFERENCES crm_reference_definitions(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE crm_number_partitions (
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  series_id       UUID NOT NULL,
  partition_key   TEXT NOT NULL CHECK(length(partition_key) BETWEEN 1 AND 300),
  next_value      BIGINT NOT NULL CHECK(next_value BETWEEN 0 AND 999999999999),
  allocated_count BIGINT NOT NULL DEFAULT 0 CHECK(allocated_count>=0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,series_id,partition_key),
  FOREIGN KEY(workspace_id,series_id) REFERENCES crm_number_series(workspace_id,id) ON DELETE CASCADE
);

-- A counter only moves forward. There is no decrement, reset or reuse command.
CREATE FUNCTION public.crm_number_partition_forward() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.next_value<OLD.next_value OR NEW.allocated_count<OLD.allocated_count
    OR ROW(NEW.workspace_id,NEW.series_id,NEW.partition_key) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.series_id,OLD.partition_key) THEN
    RAISE EXCEPTION 'crm_number_partition_forward_only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_number_partition_forward BEFORE UPDATE ON crm_number_partitions
  FOR EACH ROW EXECUTE FUNCTION public.crm_number_partition_forward();

CREATE TABLE crm_business_references (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_id       UUID NOT NULL,
  definition_version  INTEGER NOT NULL CHECK(definition_version>=1),
  target_kind         TEXT NOT NULL CHECK(target_kind IN('company','deal','account','invoice')),
  target_id           UUID NOT NULL,
  printable_value     TEXT NOT NULL CHECK(length(printable_value) BETWEEN 1 AND 128),
  normalized_value    TEXT NOT NULL CHECK(length(normalized_value) BETWEEN 1 AND 128),
  origin              TEXT NOT NULL CHECK(origin IN('native','manual','external','import')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','replaced','retired')),
  format_snapshot     JSONB,
  series_id           UUID,
  partition_key       TEXT,
  counter_value       BIGINT,
  parent_reference_id UUID,
  parent_snapshot     JSONB CHECK(parent_snapshot IS NULL OR jsonb_typeof(parent_snapshot)='object'),
  business_date       DATE,
  category_key        TEXT,
  external_evidence   JSONB CHECK(external_evidence IS NULL OR jsonb_typeof(external_evidence)='object'),
  operation_id        UUID NOT NULL,
  assigned_by_kind    TEXT NOT NULL,
  assigned_by_id      TEXT NOT NULL,
  assigned_by_user_id UUID,
  status_reason       TEXT CHECK(status_reason IS NULL OR length(status_reason) BETWEEN 1 AND 2000),
  version             INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,definition_id) REFERENCES crm_reference_definitions(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,series_id) REFERENCES crm_number_series(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,parent_reference_id) REFERENCES crm_business_references(workspace_id,id) ON DELETE CASCADE,
  CHECK((series_id IS NULL)=(counter_value IS NULL)),
  CHECK(series_id IS NULL OR partition_key IS NOT NULL)
);
-- Every current and former value stays reserved in its namespace.
CREATE UNIQUE INDEX crm_business_references_value
  ON crm_business_references(workspace_id,definition_id,normalized_value);
CREATE UNIQUE INDEX crm_business_references_current
  ON crm_business_references(workspace_id,definition_id,target_id) WHERE status='active';
CREATE UNIQUE INDEX crm_business_references_counter
  ON crm_business_references(workspace_id,series_id,partition_key,counter_value) WHERE counter_value IS NOT NULL;
CREATE INDEX crm_business_references_target ON crm_business_references(workspace_id,target_id,created_at,id);
CREATE INDEX crm_business_references_lookup ON crm_business_references(workspace_id,normalized_value text_pattern_ops);

CREATE FUNCTION public.crm_business_reference_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.definition_id,NEW.definition_version,NEW.target_kind,NEW.target_id,
         NEW.printable_value,NEW.normalized_value,NEW.origin,NEW.format_snapshot,NEW.series_id,NEW.partition_key,
         NEW.counter_value,NEW.parent_reference_id,NEW.parent_snapshot,NEW.business_date,NEW.category_key,
         NEW.external_evidence,NEW.operation_id,NEW.assigned_by_kind,NEW.assigned_by_id,NEW.assigned_by_user_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.workspace_id,OLD.definition_id,OLD.definition_version,OLD.target_kind,OLD.target_id,
         OLD.printable_value,OLD.normalized_value,OLD.origin,OLD.format_snapshot,OLD.series_id,OLD.partition_key,
         OLD.counter_value,OLD.parent_reference_id,OLD.parent_snapshot,OLD.business_date,OLD.category_key,
         OLD.external_evidence,OLD.operation_id,OLD.assigned_by_kind,OLD.assigned_by_id,OLD.assigned_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'crm_business_reference_immutable' USING ERRCODE='23514';
  END IF;
  IF NOT(OLD.status=NEW.status OR (OLD.status='active' AND NEW.status IN('replaced','retired'))) THEN
    RAISE EXCEPTION 'crm_business_reference_transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_business_reference_immutable BEFORE UPDATE ON crm_business_references
  FOR EACH ROW EXECUTE FUNCTION public.crm_business_reference_immutable();

CREATE TABLE crm_business_reference_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reference_id   UUID NOT NULL,
  definition_id  UUID NOT NULL,
  target_kind    TEXT NOT NULL CHECK(target_kind IN('company','deal','account','invoice')),
  target_id      UUID NOT NULL,
  action         TEXT NOT NULL CHECK(action IN('assigned','replaced','retired','imported')),
  former_value   TEXT CHECK(former_value IS NULL OR length(former_value) BETWEEN 1 AND 128),
  new_value      TEXT CHECK(new_value IS NULL OR length(new_value) BETWEEN 1 AND 128),
  reason         TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_user_id  UUID,
  operation_id   UUID NOT NULL,
  effective_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,reference_id) REFERENCES crm_business_references(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,definition_id) REFERENCES crm_reference_definitions(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX crm_business_reference_history_target ON crm_business_reference_history(workspace_id,target_id,effective_at,id);

-- Transaction-owned operation registry for every commercial command.
CREATE TABLE crm_operation_receipts (
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id        UUID NOT NULL,
  command_kind        TEXT NOT NULL CHECK(command_kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_kind          TEXT NOT NULL,
  actor_id            TEXT NOT NULL,
  result              JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,operation_id)
);

CREATE FUNCTION public.crm_commercial_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'crm_commercial_record_append_only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER crm_business_reference_history_append_only BEFORE UPDATE ON crm_business_reference_history
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_append_only();
CREATE TRIGGER crm_operation_receipts_append_only BEFORE UPDATE ON crm_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION public.crm_commercial_append_only();

-- Members may read; only the canonical service transaction writes.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['crm_reference_definitions','crm_number_series','crm_number_partitions',
    'crm_business_references','crm_business_reference_history','crm_operation_receipts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT USING(workspace_id IN(SELECT workspace_id FROM workspace_members
      WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid))$p$,table_name||'_member_read',table_name);
    EXECUTE format($p$CREATE POLICY %I ON public.%I USING(current_setting('app.system_bypass',true)='true')
      WITH CHECK(current_setting('app.system_bypass',true)='true')$p$,table_name||'_system',table_name);
    EXECUTE format('CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write()',table_name);
  END LOOP;
END;
$$;

-- Reference events are subject to their company or deal, so the outbox
-- derives their source floor from the canonical entity like a deal event.
CREATE OR REPLACE FUNCTION crm_event_entity_source(w uuid,k text,i uuid,lock_source boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text; col text; result uuid;
BEGIN
  CASE k
    WHEN 'contact','deal','company' THEN tab='entities';col='id';
    WHEN 'submission' THEN tab='association_enquiries';col='contact_id';
    WHEN 'entitlement' THEN tab='association_memberships';col='contact_id';
    WHEN 'participation' THEN tab='association_registrations';col='attendee_contact_id';
    ELSE RETURN NULL;
  END CASE;
  EXECUTE format('SELECT %I FROM %I WHERE workspace_id=$1 AND id=$2%s%s',col,tab,
    CASE k WHEN 'contact' THEN ' AND kind=''person''' WHEN 'deal' THEN ' AND kind=''deal''' WHEN 'company' THEN ' AND kind=''company''' ELSE '' END,
    CASE WHEN lock_source THEN ' FOR SHARE' ELSE '' END)
    INTO result USING w,i;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION crm_event_entity_source(uuid,text,uuid,boolean) FROM PUBLIC;

ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT crm_domain_event_outbox_event_type_check;
ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_event_type_check CHECK(event_type IN(
  'crm.submission.received','crm.submission.updated','crm.consent.changed','crm.suppression.changed','crm.entitlement.changed',
  'crm.participation.changed','crm.deal.stage_changed','association.inventory.sold_out','association.inventory.available',
  'crm.reference.assigned','crm.reference.replaced','crm.reference.retired'));
ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT crm_domain_event_outbox_subject_kind_check;
ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_subject_kind_check
  CHECK(subject_kind IN('submission','contact','entitlement','participation','deal','event','ticket','company'));

-- Reference grants for CRM-key integrations.
ALTER TABLE crm_integration_credential_grants DROP CONSTRAINT crm_integration_credential_grants_operation_check;
ALTER TABLE crm_integration_credential_grants ADD CONSTRAINT crm_integration_credential_grants_operation_check CHECK (operation IN (
  'crm.records.read','crm.records.write','crm.catalog.read','crm.catalog.configure',
  'crm.submissions.read','crm.submissions.write','crm.consent.read','crm.consent.write',
  'crm.entitlements.read','crm.entitlements.write','crm.participation.read','crm.participation.write',
  'crm.imports.read','crm.imports.write','crm.audit.read','crm.privacy.export','crm.privacy.retention',
  'crm.delivery.read','crm.delivery.dispatch','association.read','association.orders.write',
  'association.provider_events.write','crm.references.read','crm.references.write','crm.references.configure'));

-- Recovery capture is schema-driven; register the new tables in this release.
SELECT public.crm_install_erasure_capture();

COMMIT;
