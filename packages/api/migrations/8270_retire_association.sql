-- Retire the unused Association vertical; preserve the generic CRM records.
-- Spec: docs/architecture/features/association-operations.md#retirement-2026-11-15
-- [COMP:crm/association-retirement]
BEGIN;
SET LOCAL row_security = off;

-- The migration owner temporarily suspends named application triggers on only
-- these tables. Foreign keys and CHECK constraints remain active throughout.
-- Snapshot and restore their exact enablement and FORCE RLS states atomically.
CREATE TEMP TABLE association_retirement_tables ON COMMIT DROP AS
SELECT c.oid, c.relname, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname=ANY(ARRAY[
    'association_waitlist_offers',
    'association_provider_events',
    'association_promotion_uses',
    'association_promotion_source_contact_uses',
    'association_order_lines',
    'association_orders',
    'association_notification_outbox',
    'association_membership_offline_rescues',
    'association_sponsorship_invitations',
    'association_sponsorship_allocations',
    'association_membership_source_imports',
    'association_membership_checkouts',
    'association_promotions',
    'association_inventory_boundaries',
    'association_ticket_types',
    'association_membership_catalogue_revisions',
    'association_membership_catalogues',
    'association_programme_catalogue_revisions',
    'association_programme_catalogues',
    'association_site_content_revisions',
    'association_site_content',
    'association_memberships',
    'association_registrations',
    'association_integration_events',
    'association_audit_log',
    'workspace_modules',
    'workspaces',
    'assistant_capabilities',
    'crm_integration_credential_grants',
    'crm_domain_event_outbox'
]);
CREATE TEMP TABLE association_retirement_triggers ON COMMIT DROP AS
SELECT t.tgrelid, t.tgname, t.tgenabled, c.relname
FROM pg_trigger t JOIN association_retirement_tables c ON c.oid=t.tgrelid
WHERE NOT t.tgisinternal AND t.tgenabled<>'D';
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM association_retirement_tables ORDER BY oid LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',r.relname);
    IF r.relforcerowsecurity THEN EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY',r.relname); END IF;
  END LOOP;
  FOR r IN SELECT * FROM association_retirement_triggers LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',r.relname,r.tgname);
  END LOOP;
END $$;

-- Capture commerce ownership before deleting links. Independent CRM grants,
-- plans, events, identities, consent and submissions are not selected.
CREATE TEMP TABLE association_retired_memberships ON COMMIT DROP AS
SELECT workspace_id,id FROM association_memberships
WHERE membership_checkout_id IS NOT NULL OR sponsorship_allocation_id IS NOT NULL
UNION SELECT workspace_id,membership_id FROM association_membership_offline_rescues WHERE membership_id IS NOT NULL
UNION SELECT workspace_id,sponsor_membership_id FROM association_sponsorship_allocations
UNION SELECT workspace_id,membership_id FROM association_sponsorship_invitations WHERE membership_id IS NOT NULL
UNION SELECT workspace_id,membership_id FROM association_membership_source_imports
UNION SELECT workspace_id,entitlement_id FROM association_integration_events WHERE entitlement_id IS NOT NULL;

CREATE TEMP TABLE association_retired_participation ON COMMIT DROP AS
SELECT workspace_id,id FROM association_registrations WHERE order_id IS NOT NULL OR ticket_id IS NOT NULL;

DELETE FROM association_integration_events;
DELETE FROM association_registrations WHERE order_id IS NOT NULL OR ticket_id IS NOT NULL;
DELETE FROM association_audit_log a WHERE subject_kind IN
 ('order','ticket','promotion','site_content','membership_catalogue','programme_catalogue',
  'provider_event','provider_receipt','notification','sponsorship_allocation','sponsorship_invitation',
  'membership_rescue','membership_checkout')
 OR (subject_kind IN ('membership','entitlement') AND EXISTS(
   SELECT 1 FROM association_retired_memberships m WHERE m.workspace_id=a.workspace_id AND m.id=a.subject_id))
 OR (subject_kind IN ('registration','participation') AND EXISTS(
   SELECT 1 FROM association_retired_participation p WHERE p.workspace_id=a.workspace_id AND p.id=a.subject_id));
DELETE FROM crm_domain_event_outbox e WHERE event_type LIKE 'association.%'
 OR (subject_kind='entitlement' AND EXISTS(
   SELECT 1 FROM association_retired_memberships m WHERE m.workspace_id=e.workspace_id AND m.id=e.subject_id))
 OR (subject_kind='participation' AND EXISTS(
   SELECT 1 FROM association_retired_participation p WHERE p.workspace_id=e.workspace_id AND p.id=e.subject_id));

DELETE FROM association_waitlist_offers;
DELETE FROM association_provider_events;
DELETE FROM association_promotion_uses;
DELETE FROM association_promotion_source_contact_uses;
DELETE FROM association_order_lines;
DELETE FROM association_orders;
DELETE FROM association_notification_outbox;
DELETE FROM association_membership_offline_rescues;
DELETE FROM association_sponsorship_invitations;
DELETE FROM association_sponsorship_allocations;
DELETE FROM association_membership_source_imports;
DELETE FROM association_memberships m USING association_retired_memberships retired WHERE m.workspace_id=retired.workspace_id AND m.id=retired.id;
DELETE FROM association_membership_checkouts;
DELETE FROM association_promotions;
DELETE FROM association_inventory_boundaries;
DELETE FROM association_ticket_types;
DELETE FROM association_membership_catalogue_revisions;
DELETE FROM association_membership_catalogues;
DELETE FROM association_programme_catalogue_revisions;
DELETE FROM association_programme_catalogues;
DELETE FROM association_site_content_revisions;
DELETE FROM association_site_content;

-- Remove the obsolete grants, navigation and lifecycle identity. Other apps
-- keep their order, grants and registry records.
UPDATE workspaces SET home_apps=home_apps-'association' WHERE home_apps ? 'association';
DELETE FROM assistant_capabilities WHERE capability='association' OR capability LIKE 'home_app:association:%';
DELETE FROM crm_integration_credential_grants WHERE operation LIKE 'association.%';
DELETE FROM workspace_modules WHERE module_key='association';
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE workspace_modules ADD CONSTRAINT association_module_retired CHECK(module_key<>'association');

-- Do not provision retired lifecycle rows for future workspaces.
DROP TRIGGER workspaces_provision_modules ON workspaces;
DROP FUNCTION public.provision_workspace_modules();
DELETE FROM association_retirement_triggers WHERE relname='workspaces' AND tgname='workspaces_provision_modules';

-- Empty historical tables stay readable by shared CRM privacy and authority
-- consumers. Stale binaries cannot refill this retired vertical after upgrade.
ALTER TABLE association_integration_events ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_waitlist_offers ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_provider_events ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_promotion_uses ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_promotion_source_contact_uses ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_order_lines ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_orders ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_notification_outbox ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_membership_offline_rescues ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_sponsorship_invitations ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_sponsorship_allocations ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_membership_source_imports ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_membership_checkouts ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_promotions ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_ticket_types ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_membership_catalogue_revisions ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_membership_catalogues ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_programme_catalogue_revisions ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_programme_catalogues ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_site_content_revisions ADD CONSTRAINT association_records_retired CHECK(false);
ALTER TABLE association_site_content ADD CONSTRAINT association_records_retired CHECK(false);

DO $$ DECLARE r record; mode text; BEGIN
  FOR r IN SELECT * FROM association_retirement_triggers LOOP
    mode:=CASE r.tgenabled WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END;
    EXECUTE format('ALTER TABLE public.%I %s TRIGGER %I',r.relname,mode,r.tgname);
  END LOOP;
  FOR r IN SELECT * FROM association_retirement_tables WHERE relforcerowsecurity LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',r.relname);
  END LOOP;
END $$;
COMMIT;
