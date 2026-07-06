-- Migration 296 — CRM → entity DROP (the destructive half; 295 was the
-- additive backfill).
--
-- Part of docs/plans/crm-entity-unification.md. Lands LAST (§5): only
-- after every reader and writer has been repointed off contacts/companies/
-- deals and onto `entities` (kind + attributes + edges). A person/company/
-- deal is now an `entities` row; these specialization tables hold nothing
-- the engine still reads.
--
-- Open tables → open submodule; bump the platform `sidanclaw` gitlink.

BEGIN;

-- ── 1. Residual audit/verification cleanup (§8-4) ─────────────────────
-- Migration 295 repointed every brain_verifications / correction_audit row
-- whose CRM target still had a live entity (via the supersession-chain
-- map). Rows whose target CRM record was DELETED (its chain reaches no
-- live entity) could not be repointed and would violate the tightened
-- CHECK below. Delete them — they are audit trails for records that no
-- longer exist in any form.
DELETE FROM brain_verifications WHERE target_kind IN ('contact', 'company', 'deal');
DELETE FROM correction_audit    WHERE primitive   IN ('contact', 'company', 'deal');

-- ── 2. Tighten brain_verifications.target_kind CHECK ──────────────────
-- Drop the CRM kinds from the allowed set now that no row references them.
ALTER TABLE brain_verifications DROP CONSTRAINT IF EXISTS brain_verifications_target_kind_check;
ALTER TABLE brain_verifications ADD CONSTRAINT brain_verifications_target_kind_check
  CHECK (target_kind = ANY (ARRAY['entity'::text, 'entity_link'::text, 'task'::text, 'workspace_file'::text]));

-- ── 3. Drop the specialization tables ─────────────────────────────────
-- CASCADE removes their FKs, cross-workspace triggers
-- (contacts_company_workspace_match_trg / deals_links_workspace_match_trg),
-- set_updated_at triggers, RLS policies, CHECK constraints, and indexes.
-- Drop in dependency order (deals → contacts → companies) for clarity;
-- CASCADE makes the order non-load-bearing.
DROP TABLE IF EXISTS deals CASCADE;
DROP TABLE IF EXISTS contacts CASCADE;
DROP TABLE IF EXISTS companies CASCADE;

COMMIT;
