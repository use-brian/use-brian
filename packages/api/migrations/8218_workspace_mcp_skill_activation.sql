BEGIN;
ALTER TABLE workspace_mcp_contexts ADD COLUMN activated_skill_slugs text[] NOT NULL DEFAULT '{}';
COMMIT;
