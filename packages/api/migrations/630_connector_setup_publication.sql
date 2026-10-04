-- Canonical connector publication protocol. Legacy workspaces retain their
-- existing writers. Ready-mode publications require a saved, live setup; this
-- does NOT enable Simple mode or certify any provider catalog exception.
BEGIN;
ALTER TABLE public.connector_instance ADD COLUMN setup_version bigint NOT NULL DEFAULT 1,
 ADD COLUMN setup_managed boolean NOT NULL DEFAULT false;
ALTER TABLE public.connector_grant ADD COLUMN setup_version bigint NOT NULL DEFAULT 1;
CREATE TABLE public.connector_setup_identity (
  instance_id uuid PRIMARY KEY REFERENCES public.connector_instance(id) ON DELETE CASCADE,
  account_digest text NOT NULL CHECK(account_digest ~ '^[a-f0-9]{64}$'),
  setup_id uuid NOT NULL REFERENCES public.connector_pending_setups(id)
);
ALTER TABLE public.connector_setup_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_setup_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_setup_identity_system ON public.connector_setup_identity FOR ALL
 USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');

-- OAuth app material is never an instance, discovery row or review payload.
CREATE TABLE public.connector_setup_auth_material (
 setup_id uuid PRIMARY KEY REFERENCES public.connector_pending_setups(id) ON DELETE CASCADE,
 encrypted_payload bytea NOT NULL
);
ALTER TABLE public.connector_setup_auth_material ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_setup_auth_material FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_setup_auth_material_system ON public.connector_setup_auth_material FOR ALL
 USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');

-- Durable consumption fence. An uncertain outcome MUST NOT retry the old
-- refresh token. A returned tuple can resume verification without re-exchange.
CREATE TABLE public.connector_rotation_attempts (
 instance_id uuid NOT NULL REFERENCES public.connector_instance(id) ON DELETE CASCADE,
 refresh_fingerprint text NOT NULL CHECK(refresh_fingerprint ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('uncertain','pending_verification','published','reconnect_required')),
 encrypted_result bytea,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(instance_id,refresh_fingerprint),
 CHECK((status='pending_verification') = (encrypted_result IS NOT NULL))
);
ALTER TABLE public.connector_rotation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_rotation_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_rotation_attempts_system ON public.connector_rotation_attempts FOR ALL
 USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');

-- One-use publication receipt created only by the internal provider rotation
-- callback after live identity verification. Never a JSON/HTTP proof.
CREATE TABLE public.connector_setup_rotation_receipts (
 instance_id uuid PRIMARY KEY REFERENCES public.connector_instance(id) ON DELETE CASCADE,
 transaction_id bigint NOT NULL, expected_version bigint NOT NULL,
 account_digest text NOT NULL, credentials bytea NOT NULL
);
ALTER TABLE public.connector_setup_rotation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_setup_rotation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_setup_rotation_system ON public.connector_setup_rotation_receipts FOR ALL
 USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');

CREATE FUNCTION public.guard_connector_setup_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  w uuid; sid uuid; s public.connector_pending_setups%ROWTYPE;
  required boolean := false; material boolean := true;
  old_workspace uuid;
BEGIN
  IF TG_OP='UPDATE' THEN NEW.setup_version := OLD.setup_version+1; END IF;
  IF TG_TABLE_NAME='connector_instance' THEN
    IF TG_OP='UPDATE' THEN
      NEW.setup_managed := OLD.setup_managed;
      material := ROW(NEW.scope,NEW.user_id,NEW.workspace_id,NEW.provider,NEW.custom,NEW.credentials_type,NEW.credentials,NEW.config,NEW.url,NEW.sensitivity,
        NEW.compartments,NEW.project_ids)
        IS DISTINCT FROM ROW(OLD.scope,OLD.user_id,OLD.workspace_id,OLD.provider,OLD.custom,OLD.credentials_type,OLD.credentials,OLD.config,OLD.url,OLD.sensitivity,
        OLD.compartments,OLD.project_ids)
        OR (NEW.ingest_workspace_id IS NOT NULL AND NEW.ingest_workspace_id IS DISTINCT FROM OLD.ingest_workspace_id)
        OR (NEW.connected AND NOT OLD.connected) OR (NEW.ingestion_enabled AND NOT OLD.ingestion_enabled);
    END IF;
    IF NOT material THEN RETURN NEW; END IF;
    w := NEW.workspace_id;
    IF TG_OP='UPDATE' THEN old_workspace := OLD.workspace_id; END IF;
    -- Row triggers already hold the resource lock: they cannot safely wait
    -- for an earlier lock in the protocol. Canonical setup owns this entire
    -- sorted set already. Old writers fail with retryable 55P03 on contention,
    -- rolling back rather than forming resource -> workspace wait cycles.
    PERFORM id FROM public.workspaces WHERE id=w OR id=old_workspace OR id IN
      (SELECT target_id FROM public.connector_grant WHERE connector_instance_id=NEW.id) ORDER BY id FOR UPDATE NOWAIT;
    required := EXISTS(SELECT 1 FROM public.workspace_access_policies p WHERE p.workspace_id=w AND p.setup_state='ready')
      OR EXISTS(SELECT 1 FROM public.connector_grant g JOIN public.workspace_access_policies p ON p.workspace_id=g.target_id
        WHERE g.connector_instance_id=NEW.id AND p.setup_state='ready');
    -- Once created by the protocol, personal credentials cannot be replaced
    -- through the legacy primary-account fallback either.
    IF TG_OP='UPDATE' THEN
      NEW.setup_managed := OLD.setup_managed;
      required := required OR OLD.setup_managed OR EXISTS(SELECT 1 FROM public.workspace_access_policies p
        WHERE p.workspace_id=OLD.workspace_id AND p.setup_state='ready');
    END IF;
  ELSE
    w := NEW.target_id;
    IF TG_OP='UPDATE' THEN old_workspace := OLD.target_id; END IF;
    PERFORM id FROM public.workspaces WHERE id=w OR id=old_workspace ORDER BY id FOR UPDATE NOWAIT;
    required := EXISTS(SELECT 1 FROM public.workspace_access_policies p WHERE p.workspace_id=w AND p.setup_state='ready');
    IF TG_OP='UPDATE' THEN
      required := required OR EXISTS(SELECT 1 FROM public.workspace_access_policies p WHERE p.workspace_id=OLD.target_id AND p.setup_state='ready');
    END IF;
  END IF;
  IF TG_TABLE_NAME='connector_instance' AND TG_OP='UPDATE' THEN
   IF NEW.provider='shopify' AND OLD.setup_managed
    AND NEW.connected AND NEW.health_status='ok' AND NEW.last_error IS NULL
    AND (to_jsonb(NEW)-ARRAY['credentials','setup_version','updated_at','health_status','last_error'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['credentials','setup_version','updated_at','health_status','last_error']) THEN
    DELETE FROM public.connector_setup_rotation_receipts r USING public.connector_setup_identity i
      WHERE r.instance_id=NEW.id AND r.transaction_id=txid_current() AND r.expected_version=OLD.setup_version
        AND r.credentials=NEW.credentials AND i.instance_id=r.instance_id AND i.account_digest=r.account_digest;
    IF FOUND THEN RETURN NEW; END IF;
   END IF;
  END IF;
  sid := nullif(current_setting('app.connector_setup_id',true),'')::uuid;
  IF NOT required AND sid IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.connector_pending_setups WHERE id=sid;
  IF s.id IS NULL OR s.status<>'ready' OR s.expires_at<=clock_timestamp()
    OR s.saved_consent_digest IS DISTINCT FROM s.consent_digest OR s.saved_consent_digest IS NULL THEN
    RAISE EXCEPTION 'connector_setup_required';
  END IF;
  -- Use the common workspace serialization lock, even for direct old writers.
  PERFORM id FROM public.workspaces WHERE id=s.workspace_id FOR UPDATE NOWAIT;
  IF NOT EXISTS(SELECT 1 FROM public.workspace_access_policies p WHERE p.workspace_id=s.workspace_id
    AND p.revision=s.policy_revision) OR NOT EXISTS(SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id=s.workspace_id AND m.user_id=s.actor_user_id AND m.role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'connector_setup_stale';
  END IF;
  IF TG_TABLE_NAME='connector_instance' THEN
    NEW.setup_managed := true;
    IF NEW.provider<>s.provider OR NEW.ingestion_enabled OR NEW.ingest_workspace_id IS NOT NULL THEN
      -- Reconnect may retain already-approved ingestion routing unchanged.
      IF NOT (TG_OP='UPDATE' AND s.intent->>'operation'='reconnect' AND NEW.provider=s.provider
        AND NEW.ingestion_enabled=OLD.ingestion_enabled AND NEW.ingest_workspace_id IS NOT DISTINCT FROM OLD.ingest_workspace_id) THEN
        RAISE EXCEPTION 'connector_setup_binding_mismatch';
      END IF;
    END IF;
    IF TG_OP='INSERT' THEN
      IF s.intent->>'operation'<>'create' OR NEW.created_by IS DISTINCT FROM s.actor_user_id THEN RAISE EXCEPTION 'connector_setup_target_mismatch'; END IF;
    ELSE
      IF s.intent->'target'->>'instanceId'<>NEW.id::text OR s.intent->'target'->>'version'<>OLD.setup_version::text
        OR s.intent->>'operation' NOT IN ('reconnect','transfer') THEN RAISE EXCEPTION 'connector_setup_target_mismatch'; END IF;
    END IF;
    IF (s.intent->>'ownership'='workspace' AND (NEW.scope<>'workspace' OR NEW.workspace_id IS DISTINCT FROM s.workspace_id))
      OR (s.intent->>'ownership'='personal' AND (NEW.scope<>'user' OR NEW.user_id IS DISTINCT FROM s.actor_user_id))
      OR to_jsonb(NEW.compartments) IS DISTINCT FROM s.intent->'binding'->'departments'
      OR to_jsonb(NEW.project_ids::text[]) IS DISTINCT FROM s.intent->'binding'->'projects'
      OR NEW.sensitivity IS DISTINCT FROM s.intent->'binding'->>'sensitivityFloor' THEN RAISE EXCEPTION 'connector_setup_binding_mismatch'; END IF;
  ELSE
    IF s.intent->>'operation'<>'share' OR NEW.connector_instance_id::text IS DISTINCT FROM s.intent->'target'->>'instanceId'
      OR NEW.target_id IS DISTINCT FROM s.workspace_id OR NEW.granted_by_user_id IS DISTINCT FROM s.actor_user_id
      OR to_jsonb(NEW.compartments) IS DISTINCT FROM s.intent->'binding'->'departments'
      OR to_jsonb(NEW.project_ids::text[]) IS DISTINCT FROM s.intent->'binding'->'projects' THEN RAISE EXCEPTION 'connector_setup_binding_mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_setup_publication BEFORE INSERT OR UPDATE ON public.connector_instance
 FOR EACH ROW EXECUTE FUNCTION public.guard_connector_setup_publication();
CREATE TRIGGER connector_setup_publication BEFORE INSERT OR UPDATE ON public.connector_grant
 FOR EACH ROW EXECUTE FUNCTION public.guard_connector_setup_publication();
REVOKE ALL ON FUNCTION public.guard_connector_setup_publication() FROM PUBLIC;
COMMIT;
