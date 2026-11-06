-- [COMP:api/workspace-mcp] Exact native attachment parents, never detached byte grants.
BEGIN;
ALTER TABLE file_cache
 ADD COLUMN source_file_id uuid REFERENCES workspace_files(id) ON DELETE CASCADE,
 ADD COLUMN source_file_version bigint,
 ADD CONSTRAINT file_cache_source_pair CHECK ((source_file_id IS NULL)=(source_file_version IS NULL));
CREATE INDEX file_cache_source_file ON file_cache(source_file_id) WHERE source_file_id IS NOT NULL;
CREATE FUNCTION guard_file_cache_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.source_file_id IS DISTINCT FROM OLD.source_file_id
   OR NEW.source_file_version IS DISTINCT FROM OLD.source_file_version) THEN
  RAISE EXCEPTION 'file_cache_source_immutable' USING ERRCODE='42501';
 END IF;
 IF NEW.source_file_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM workspace_files f WHERE f.id=NEW.source_file_id AND f.workspace_id=NEW.workspace_id
   AND f.scope_version=NEW.source_file_version AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held
   AND sensitivity_rank(NEW.sensitivity)>=sensitivity_rank(f.sensitivity)
   AND NEW.compartments @> f.compartments AND NEW.project_ids @> f.project_ids
   AND (f.user_id IS NULL OR f.user_id=NEW.user_id)
   AND (f.assistant_id IS NULL OR f.assistant_id=NEW.assistant_id)
 ) THEN RAISE EXCEPTION 'file_cache_source_unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_cache_source_guard BEFORE INSERT OR UPDATE ON file_cache FOR EACH ROW EXECUTE FUNCTION guard_file_cache_source();
CREATE POLICY file_cache_source_read ON file_cache AS RESTRICTIVE FOR SELECT USING (
 source_file_id IS NULL OR EXISTS(SELECT 1 FROM workspace_files f WHERE f.id=source_file_id
  AND f.workspace_id=file_cache.workspace_id AND f.scope_version=source_file_version
  AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held)
);
COMMIT;
