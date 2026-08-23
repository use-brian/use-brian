-- Association operations: CRM-linked enquiries, consent, membership, events,
-- inventory-backed registrations/orders, provider reconciliation, and outbox.
-- Spec: docs/architecture/features/association-operations.md

BEGIN;

CREATE TABLE association_external_identities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL,
  provider         TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 500),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, provider_subject),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX association_external_identities_contact
  ON association_external_identities(workspace_id, contact_id);

CREATE TABLE association_enquiries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL,
  source               TEXT NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,62}$'),
  source_submission_id TEXT NOT NULL CHECK (length(source_submission_id) BETWEEN 1 AND 500),
  request_fingerprint  TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  subject              TEXT NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 300),
  message              TEXT NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 20000),
  submitted_data       JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(submitted_data) = 'object'),
  status               TEXT NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new','in_progress','resolved','spam')),
  queue_key            TEXT NOT NULL DEFAULT 'general'
                         CHECK (queue_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  owner_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source, source_submission_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX association_enquiries_queue
  ON association_enquiries(workspace_id, status, queue_key, created_at DESC, id DESC);
CREATE INDEX association_enquiries_owner
  ON association_enquiries(workspace_id, owner_user_id, status, created_at DESC);

CREATE TABLE association_enquiry_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enquiry_id          UUID NOT NULL,
  body                TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('api_key','oauth_token','home_app','provider')),
  actor_credential_id TEXT NOT NULL CHECK (length(actor_credential_id) BETWEEN 1 AND 200),
  acting_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, enquiry_id)
    REFERENCES association_enquiries(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX association_enquiry_notes_timeline
  ON association_enquiry_notes(workspace_id, enquiry_id, created_at, id);

CREATE TABLE association_consent_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id        UUID NOT NULL,
  purpose           TEXT NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_-]{0,62}$'),
  action            TEXT NOT NULL CHECK (action IN ('granted','withdrawn')),
  wording_version   TEXT NOT NULL CHECK (length(wording_version) BETWEEN 1 AND 100),
  source            TEXT NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,62}$'),
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider          TEXT CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_event_id TEXT CHECK (provider_event_id IS NULL OR length(provider_event_id) BETWEEN 1 AND 500),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((provider IS NULL) = (provider_event_id IS NULL)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX association_consent_contact_timeline
  ON association_consent_events(workspace_id, contact_id, purpose, occurred_at DESC, id DESC);
CREATE UNIQUE INDEX association_consent_provider_event_once
  ON association_consent_events(workspace_id, provider, provider_event_id)
  WHERE provider IS NOT NULL;

CREATE TABLE association_membership_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_key          TEXT NOT NULL CHECK (plan_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  name              TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  currency          TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  fee_minor         BIGINT NOT NULL CHECK (fee_minor >= 0),
  billing_period    TEXT NOT NULL
                      CHECK (billing_period IN ('one_time','monthly','annual','lifetime','manual')),
  benefits          TEXT[] NOT NULL DEFAULT '{}',
  eligibility_note  TEXT CHECK (eligibility_note IS NULL OR length(eligibility_note) <= 5000),
  active_from       TIMESTAMPTZ,
  active_to         TIMESTAMPTZ,
  published         BOOLEAN NOT NULL DEFAULT false,
  provider          TEXT CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_plan_id  TEXT CHECK (provider_plan_id IS NULL OR length(provider_plan_id) BETWEEN 1 AND 500),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (active_to IS NULL OR active_from IS NULL OR active_to > active_from),
  CHECK ((provider IS NULL) = (provider_plan_id IS NULL)),
  UNIQUE (workspace_id, plan_key),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX association_plans_provider_once
  ON association_membership_plans(workspace_id, provider, provider_plan_id)
  WHERE provider IS NOT NULL;
CREATE INDEX association_plans_published
  ON association_membership_plans(workspace_id, published, created_at DESC);

CREATE TABLE association_memberships (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id             UUID NOT NULL,
  plan_id                UUID NOT NULL,
  idempotency_key        TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint    TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','active','expired','cancelled')),
  starts_at              TIMESTAMPTZ NOT NULL,
  ends_at                TIMESTAMPTZ,
  renewal_mode           TEXT NOT NULL DEFAULT 'none'
                           CHECK (renewal_mode IN ('none','manual','auto')),
  provider               TEXT CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_membership_id TEXT CHECK (provider_membership_id IS NULL OR length(provider_membership_id) BETWEEN 1 AND 500),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK ((provider IS NULL) = (provider_membership_id IS NULL)),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, plan_id)
    REFERENCES association_membership_plans(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX association_memberships_contact
  ON association_memberships(workspace_id, contact_id, status, starts_at DESC);
CREATE UNIQUE INDEX association_memberships_provider_once
  ON association_memberships(workspace_id, provider, provider_membership_id)
  WHERE provider IS NOT NULL;

CREATE TABLE association_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug                    TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  programme_key           TEXT CHECK (programme_key IS NULL OR programme_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  title                   TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  description             TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 50000),
  starts_at               TIMESTAMPTZ NOT NULL,
  ends_at                 TIMESTAMPTZ NOT NULL,
  timezone                TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100),
  mode                    TEXT NOT NULL CHECK (mode IN ('venue','online','hybrid')),
  venue                   TEXT CHECK (venue IS NULL OR length(venue) <= 2000),
  online_url              TEXT CHECK (online_url IS NULL OR length(online_url) <= 2000),
  registration_opens_at   TIMESTAMPTZ,
  registration_closes_at  TIMESTAMPTZ,
  capacity                INTEGER CHECK (capacity IS NULL OR capacity > 0),
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','published','cancelled','completed')),
  canonical_url           TEXT CHECK (canonical_url IS NULL OR length(canonical_url) <= 2000),
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (registration_closes_at IS NULL OR registration_opens_at IS NULL
    OR registration_closes_at > registration_opens_at),
  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, id)
);
CREATE INDEX association_events_schedule
  ON association_events(workspace_id, status, starts_at, id);

CREATE TABLE association_ticket_types (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id             UUID NOT NULL,
  ticket_key           TEXT NOT NULL CHECK (ticket_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  name                 TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  currency             TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor          BIGINT NOT NULL CHECK (price_minor >= 0),
  member_price_minor   BIGINT CHECK (member_price_minor IS NULL OR member_price_minor >= 0),
  eligible_plan_keys   TEXT[] NOT NULL DEFAULT '{}',
  capacity             INTEGER CHECK (capacity IS NULL OR capacity > 0),
  per_order_limit      INTEGER NOT NULL DEFAULT 10 CHECK (per_order_limit BETWEEN 1 AND 1000),
  sale_starts_at       TIMESTAMPTZ,
  sale_ends_at         TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','on_sale','sold_out','closed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sale_ends_at IS NULL OR sale_starts_at IS NULL OR sale_ends_at > sale_starts_at),
  UNIQUE (event_id, ticket_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES association_events(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX association_tickets_event
  ON association_ticket_types(workspace_id, event_id, status, created_at);

CREATE TABLE association_orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id            UUID NOT NULL,
  idempotency_key       TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint   TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','paid','failed','cancelled','refunded')),
  currency              TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor        BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor        BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor           BIGINT NOT NULL CHECK (total_minor >= 0),
  reservation_expires_at TIMESTAMPTZ,
  provider              TEXT CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_reference    TEXT CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 500),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX association_orders_contact
  ON association_orders(workspace_id, contact_id, created_at DESC, id DESC);
CREATE INDEX association_orders_pending_expiry
  ON association_orders(workspace_id, reservation_expires_at)
  WHERE status = 'pending';

CREATE TABLE association_order_lines (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id               UUID NOT NULL,
  ticket_id              UUID NOT NULL,
  quantity               INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor       BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor         BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  line_total_minor       BIGINT NOT NULL CHECK (line_total_minor >= 0),
  pricing_basis          TEXT NOT NULL CHECK (pricing_basis IN ('public','member')),
  eligible_membership_id UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, order_id)
    REFERENCES association_orders(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES association_ticket_types(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, eligible_membership_id)
    REFERENCES association_memberships(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX association_order_lines_order
  ON association_order_lines(workspace_id, order_id, created_at);

CREATE TABLE association_registrations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id              UUID NOT NULL,
  order_line_id         UUID NOT NULL,
  event_id              UUID NOT NULL,
  ticket_id             UUID NOT NULL,
  attendee_contact_id   UUID,
  attendee_name         TEXT NOT NULL CHECK (length(btrim(attendee_name)) BETWEEN 1 AND 200),
  attendee_email        TEXT CHECK (attendee_email IS NULL OR length(attendee_email) <= 320),
  attendee_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attendee_metadata) = 'object'),
  status                TEXT NOT NULL DEFAULT 'reserved'
                          CHECK (status IN ('reserved','confirmed','cancelled','refunded','checked_in')),
  reservation_expires_at TIMESTAMPTZ,
  checked_in_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, order_id)
    REFERENCES association_orders(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, order_line_id)
    REFERENCES association_order_lines(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES association_events(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES association_ticket_types(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attendee_contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX association_registrations_inventory
  ON association_registrations(workspace_id, ticket_id, status, reservation_expires_at);
CREATE INDEX association_registrations_event
  ON association_registrations(workspace_id, event_id, status, created_at);

CREATE TABLE association_provider_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id           UUID NOT NULL,
  provider           TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_event_id  TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 500),
  target_status      TEXT NOT NULL CHECK (target_status IN ('paid','failed','cancelled','refunded')),
  provider_reference TEXT CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 500),
  occurred_at        TIMESTAMPTZ NOT NULL,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, provider_event_id),
  FOREIGN KEY (workspace_id, order_id)
    REFERENCES association_orders(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX association_provider_events_order
  ON association_provider_events(workspace_id, order_id, occurred_at DESC);

CREATE TABLE association_notification_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('enquiry','order')),
  source_id           UUID NOT NULL,
  template_key        TEXT NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  recipient_kind      TEXT NOT NULL CHECK (recipient_kind IN ('contact','queue')),
  recipient_ref       TEXT NOT NULL CHECK (length(recipient_ref) BETWEEN 1 AND 500),
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','sending','sent','failed','suppressed')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_kind, source_id, template_key, recipient_kind, recipient_ref)
);
CREATE INDEX association_notification_pending
  ON association_notification_outbox(workspace_id, status, next_attempt_at, created_at);

CREATE TABLE association_audit_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action              TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  subject_kind        TEXT NOT NULL CHECK (length(subject_kind) BETWEEN 1 AND 100),
  subject_id          UUID NOT NULL,
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('api_key','oauth_token','home_app','provider')),
  actor_credential_id TEXT NOT NULL CHECK (length(actor_credential_id) BETWEEN 1 AND 200),
  acting_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX association_audit_subject
  ON association_audit_log(workspace_id, subject_kind, subject_id, created_at DESC);

CREATE TRIGGER association_external_identities_updated_at
  BEFORE UPDATE ON association_external_identities
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
CREATE TRIGGER association_enquiries_updated_at
  BEFORE UPDATE ON association_enquiries
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
CREATE TRIGGER association_membership_plans_updated_at
  BEFORE UPDATE ON association_membership_plans
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
CREATE TRIGGER association_memberships_updated_at
  BEFORE UPDATE ON association_memberships
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
CREATE TRIGGER association_events_updated_at
  BEFORE UPDATE ON association_events
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
CREATE TRIGGER association_ticket_types_updated_at
  BEFORE UPDATE ON association_ticket_types
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
CREATE TRIGGER association_orders_updated_at
  BEFORE UPDATE ON association_orders
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
CREATE TRIGGER association_registrations_updated_at
  BEFORE UPDATE ON association_registrations
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
CREATE TRIGGER association_notification_outbox_updated_at
  BEFORE UPDATE ON association_notification_outbox
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'association_external_identities', 'association_enquiries',
    'association_enquiry_notes',
    'association_consent_events', 'association_membership_plans',
    'association_memberships', 'association_events',
    'association_ticket_types', 'association_orders',
    'association_order_lines', 'association_registrations',
    'association_provider_events', 'association_notification_outbox',
    'association_audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting(''app.current_user_id'', true)::uuid)) WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting(''app.current_user_id'', true)::uuid))',
      table_name || '_member', table_name
    );
  END LOOP;
END $$;

COMMIT;
