-- Source context permission is not persistent derivation authority.
-- Spec: docs/architecture/features/application-platform.md.
BEGIN;

ALTER TABLE external_source_authorizations ADD COLUMN derivation_receipt text
 CHECK(derivation_receipt IS NULL OR length(derivation_receipt) BETWEEN 1 AND 1024);
-- Pre-existing short-lived receipts cannot acquire a new derivation decision.
-- NOT VALID preserves immutable history; new rows must carry the companion proof.
ALTER TABLE external_source_authorizations ADD CONSTRAINT external_source_retain_derivation
 CHECK(action<>'retain' OR derivation_receipt IS NOT NULL) NOT VALID;

CREATE FUNCTION external_source_retention_allowed(w uuid,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE snapshot jsonb;
BEGIN
 IF current_setting('app.external_source_action',true) IS DISTINCT FROM 'retain' THEN RETURN false; END IF;
 snapshot:=external_source_snapshot(w,i);
 IF snapshot IS NULL OR (snapshot->>'held')::boolean IS DISTINCT FROM false
  OR snapshot->>'version' IS DISTINCT FROM v THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM external_source_authorizations a
  JOIN external_source_observations o ON o.id=a.observation_id AND o.workspace_id=a.workspace_id
  JOIN external_source_resources r ON r.id=o.resource_id AND r.workspace_id=o.workspace_id
  JOIN connector_source_profiles p ON p.id=r.profile_id AND p.workspace_id=r.workspace_id
  WHERE a.profile_id=p.id AND a.profile_revision=p.revision AND a.resource_revision=r.revision
   AND r.state='active' AND p.status='qualified' AND a.actor_kind='human' AND a.recipient_kind='human'
   AND a.workspace_id=w AND a.observation_id=i AND a.action='retain' AND a.derivation_receipt IS NOT NULL
   AND a.operation_id=nullif(current_setting('app.external_source_operation_id',true),'')::uuid
   AND a.transaction_id=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()
   AND a.actor_id=nullif(current_setting('app.external_source_actor_id',true),'')::uuid
   AND a.assistant_id=nullif(current_setting('app.external_source_assistant_id',true),'')::uuid
   AND a.recipient_id=nullif(current_setting('app.current_user_id',true),'')::uuid
   AND a.recipient_assistant_id=nullif(current_setting('app.v2_assistant_id',true),'')::uuid
   AND a.expires_at>clock_timestamp() AND a.authority_fingerprint=external_source_authority_fingerprint(w,a.profile_id)
   AND o.observation->'actions' @> '["derive","retain"]'::jsonb
   AND o.observation->'retention'->>'mode'='governed');
END $$;
REVOKE ALL ON FUNCTION external_source_retention_allowed(uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION external_source_retention_allowed(uuid,uuid,text) TO app_user;
 END IF;
END $$;

CREATE FUNCTION guard_external_source_derivation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.source_kind='external_source' AND NOT external_source_retention_allowed(NEW.workspace_id,NEW.source_id,NEW.source_version) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_external_source_derivation() FROM PUBLIC;
CREATE TRIGGER scope_derivation_sources_retention BEFORE INSERT OR UPDATE ON scope_derivation_sources
 FOR EACH ROW EXECUTE FUNCTION guard_external_source_derivation();
COMMIT;
