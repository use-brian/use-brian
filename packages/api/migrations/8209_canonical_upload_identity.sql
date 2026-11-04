-- [COMP:files/upload-identity] Upload identity is separate from embedding hashes.
BEGIN;
ALTER TABLE workspace_files ADD COLUMN upload_identity text
  CHECK (upload_identity IS NULL OR upload_identity ~ '^[0-9a-f]{64}$');
CREATE INDEX workspace_files_upload_identity ON workspace_files(workspace_id,created_by_user_id,upload_identity)
  WHERE upload_identity IS NOT NULL AND valid_to IS NULL AND retracted_at IS NULL AND purpose='operational';

-- Mutable metadata cannot forge identity; content/representation changes invalidate it.
CREATE FUNCTION guard_file_upload_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.upload_identity IS DISTINCT FROM OLD.upload_identity AND NEW.upload_identity IS NOT NULL THEN
   RAISE EXCEPTION 'file_upload_identity_immutable';
 END IF;
 IF ROW(NEW.storage_uri,NEW.size_bytes,NEW.mime) IS DISTINCT FROM ROW(OLD.storage_uri,OLD.size_bytes,OLD.mime) THEN
   NEW.upload_identity:=NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_file_upload_identity() FROM PUBLIC;
CREATE TRIGGER file_upload_identity_immutable BEFORE UPDATE ON workspace_files
 FOR EACH ROW EXECUTE FUNCTION guard_file_upload_identity();

-- Old clients must not replace a canonical parent with a row-only media alias.
-- Preserve the existing FK erasure contract when the original file is deleted.
CREATE FUNCTION guard_recording_media_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.media_file_id IS DISTINCT FROM OLD.media_file_id
   AND EXISTS(SELECT 1 FROM recording_intake_bindings WHERE recording_id=OLD.id AND workspace_id=OLD.workspace_id)
   AND NOT (NEW.media_file_id IS NULL AND NOT EXISTS(SELECT 1 FROM workspace_files WHERE id=OLD.media_file_id)) THEN
   RAISE EXCEPTION 'recording_media_identity_immutable';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_recording_media_identity() FROM PUBLIC;
CREATE TRIGGER recording_media_identity_immutable BEFORE UPDATE OF media_file_id ON recordings
 FOR EACH ROW EXECUTE FUNCTION guard_recording_media_identity();
COMMIT;
