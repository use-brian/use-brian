-- [COMP:crm/production-import] Atomic, source-bound logical CSV layouts.
-- Old binaries continue owning their existing jobs, source bytes and receipts.
BEGIN;

CREATE TABLE crm_import_csv_indexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  staged_file_id uuid,
  source_id uuid,
  source_version text NOT NULL CHECK (source_version ~ '^[a-f0-9]{64}$'),
  parser_version integer NOT NULL CHECK (parser_version > 0),
  claim_token uuid,
  claim_expires_at timestamptz,
  source_hash text CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  total_rows integer CHECK (total_rows BETWEEN 0 AND 100000),
  headers bytea,
  CHECK (num_nonnulls(staged_file_id,source_id) = 1),
  CHECK ((claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND source_hash IS NULL AND total_rows IS NULL AND headers IS NULL)
      OR (claim_token IS NULL AND claim_expires_at IS NULL AND source_hash IS NOT NULL AND total_rows IS NOT NULL AND headers IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (workspace_id,staged_file_id,source_id,source_version,parser_version),
  FOREIGN KEY (workspace_id,source_id) REFERENCES crm_import_sources(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX crm_import_csv_index_by_source ON crm_import_csv_indexes(workspace_id,source_id) WHERE source_id IS NOT NULL;

CREATE TABLE crm_import_csv_index_chunks (
  index_id uuid NOT NULL REFERENCES crm_import_csv_indexes(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 1999),
  start_byte integer NOT NULL,
  end_byte integer NOT NULL CHECK (start_byte >= 0 AND end_byte BETWEEN start_byte AND 31457280),
  chunk_hash text NOT NULL CHECK (chunk_hash ~ '^[a-f0-9]{64}$'),
  staged_bytes bytea CHECK (staged_bytes IS NULL OR octet_length(staged_bytes) = end_byte - start_byte),
  PRIMARY KEY(index_id,chunk_index)
);

ALTER TABLE crm_import_csv_indexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_import_csv_index_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crm_import_csv_indexes,crm_import_csv_index_chunks FROM PUBLIC,app_user;

-- Outcomes and privacy erasure from an older binary must still remove the copy.
CREATE FUNCTION public.crm_import_csv_index_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_RELID = 'public.crm_import_sources'::regclass THEN
    DELETE FROM public.crm_import_csv_indexes WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id;
  ELSIF TG_RELID = 'public.workspace_files'::regclass THEN
    DELETE FROM public.crm_import_csv_indexes WHERE workspace_id=OLD.workspace_id AND staged_file_id=OLD.id;
  ELSIF TG_RELID = 'public.crm_import_jobs'::regclass THEN
    IF NEW.staged_file_id IS NOT NULL THEN
      DELETE FROM public.crm_import_csv_indexes i WHERE i.workspace_id=NEW.workspace_id AND i.staged_file_id=NEW.staged_file_id
        AND NOT EXISTS (SELECT 1 FROM public.crm_import_jobs j WHERE j.workspace_id=NEW.workspace_id
          AND j.staged_file_id=NEW.staged_file_id AND j.status NOT IN ('completed','cancelled'));
    ELSE
      DELETE FROM public.crm_import_csv_indexes i WHERE i.workspace_id=NEW.workspace_id AND i.source_id=NEW.source_id
        AND NOT EXISTS (SELECT 1 FROM public.crm_import_jobs j WHERE j.workspace_id=NEW.workspace_id
          AND j.source_id=NEW.source_id AND j.status NOT IN ('completed','cancelled'));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.crm_import_csv_index_cleanup() FROM PUBLIC,app_user;
CREATE TRIGGER crm_import_csv_index_source_retired AFTER UPDATE OF privacy_erased ON crm_import_sources
  FOR EACH ROW WHEN (NOT OLD.privacy_erased AND NEW.privacy_erased) EXECUTE FUNCTION public.crm_import_csv_index_cleanup();
CREATE TRIGGER crm_import_csv_index_file_closed AFTER UPDATE OF valid_to,retracted_at,superseded_by,storage_uri ON workspace_files
  FOR EACH ROW WHEN (OLD.valid_to IS DISTINCT FROM NEW.valid_to OR OLD.retracted_at IS DISTINCT FROM NEW.retracted_at
    OR OLD.superseded_by IS DISTINCT FROM NEW.superseded_by OR OLD.storage_uri IS DISTINCT FROM NEW.storage_uri)
  EXECUTE FUNCTION public.crm_import_csv_index_cleanup();
-- Reviewed file cleanup in older binaries classifies new file FKs as external
-- consumers. The canonical delete trigger removes this derived index instead.
CREATE TRIGGER crm_import_csv_index_file_deleted AFTER DELETE ON workspace_files
  FOR EACH ROW EXECUTE FUNCTION public.crm_import_csv_index_cleanup();
CREATE TRIGGER crm_import_csv_index_job_cancelled AFTER UPDATE OF status ON crm_import_jobs
  FOR EACH ROW WHEN (OLD.status <> 'cancelled' AND NEW.status = 'cancelled') EXECUTE FUNCTION public.crm_import_csv_index_cleanup();

COMMIT;
