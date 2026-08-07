-- 410_kb_default_sensitivity.sql (OPEN tables -> packages/api/migrations/)
-- Per-source default sensitivity for the knowledge base
-- (docs/architecture/features/knowledge-base.md -> "Per-source default sensitivity").
--
-- `default_sensitivity` is the tier stamped on synced entries whose markdown
-- carries NO explicit `sensitivity:` frontmatter. Explicit frontmatter always
-- wins - the repo stays the source of truth; this only replaces the global
-- 'internal' fallback per source.
--
-- `sensitivity_explicit` records, per entry, whether the stamp came from
-- frontmatter (true) or from the default (false). NULL = legacy row synced
-- before this migration - unknown provenance, treated as EXPLICIT (fail safe:
-- a default change never silently re-stamps a row whose provenance we cannot
-- prove; the next full re-parse walk resolves it).

BEGIN;

ALTER TABLE workspace_knowledge_sources
  ADD COLUMN default_sensitivity TEXT NOT NULL DEFAULT 'internal'
    CHECK (default_sensitivity IN ('public', 'internal', 'confidential'));

ALTER TABLE knowledge_entries
  ADD COLUMN sensitivity_explicit BOOLEAN;

COMMIT;
