BEGIN;
-- [COMP:api/crm-integration-auth] Uncertain issuance must never mint a second key.
ALTER TABLE crm_integration_credentials
  ADD COLUMN request_id uuid,
  ADD COLUMN request_fingerprint text,
  ADD CONSTRAINT crm_credential_request_pair CHECK (
    (request_id IS NULL AND request_fingerprint IS NULL) OR
    (request_id IS NOT NULL AND request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[a-f0-9]{64}$'));
CREATE UNIQUE INDEX crm_credential_request_identity ON crm_integration_credentials(workspace_id,request_id) WHERE request_id IS NOT NULL;
CREATE FUNCTION public.crm_credential_request_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint THEN
    RAISE EXCEPTION 'Credential issuance identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_credential_request_no_update BEFORE UPDATE OF request_id,request_fingerprint
ON crm_integration_credentials FOR EACH ROW EXECUTE FUNCTION public.crm_credential_request_immutable();
COMMIT;
