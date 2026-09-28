-- Office resources deduplicate only inside one durable file scope.
-- [COMP:api/office-resources]

ALTER TABLE office_resources
  DROP CONSTRAINT IF EXISTS office_resources_workspace_id_kind_content_hash_key;

CREATE UNIQUE INDEX office_resources_file_scope_identity
  ON office_resources (workspace_id, kind, content_hash, file_id)
  WHERE file_id IS NOT NULL;

CREATE UNIQUE INDEX office_resources_declarative_identity
  ON office_resources (workspace_id, kind, content_hash)
  WHERE file_id IS NULL;
