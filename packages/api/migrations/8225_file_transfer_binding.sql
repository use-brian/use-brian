-- [COMP:files/chunked-upload] Host-observed origin and expected bytes.
ALTER TABLE workspace_file_uploads ADD COLUMN transfer_binding jsonb;
CREATE FUNCTION enforce_file_transfer_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.transfer_binding IS DISTINCT FROM OLD.transfer_binding THEN RAISE EXCEPTION 'file_transfer_binding_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_transfer_binding_guard BEFORE UPDATE ON workspace_file_uploads
FOR EACH ROW EXECUTE FUNCTION enforce_file_transfer_binding();
