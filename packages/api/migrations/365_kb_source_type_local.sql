BEGIN;

ALTER TABLE workspace_knowledge_sources
  DROP CONSTRAINT team_knowledge_sources_source_type_check;

ALTER TABLE workspace_knowledge_sources
  ADD CONSTRAINT team_knowledge_sources_source_type_check
  CHECK (source_type IN ('github', 'local'));

COMMIT;
