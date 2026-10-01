-- Foundation only. No existing connector writer or provider catalog is authorized here.
BEGIN;
CREATE TABLE public.connector_pending_setups (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES public.users(id),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 100),
  intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'),
  policy_revision bigint,
  status text NOT NULL DEFAULT 'pending_auth' CHECK(status IN
    ('pending_auth','pending_review','ready','active','stale','failed','cancelled','expired')),
  version bigint NOT NULL DEFAULT 1,
  nonce_hash text CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),
  consent_digest text CHECK(consent_digest ~ '^[a-f0-9]{64}$'),
  saved_consent_digest text,
  result_ids jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK((workspace_id IS NULL) = (policy_revision IS NULL)),
  CHECK(expires_at > created_at),
  CHECK(status NOT IN ('ready','active') OR (consent_digest IS NOT NULL AND saved_consent_digest IS NOT NULL AND saved_consent_digest=consent_digest)),
  CHECK((status='active') = (result_ids IS NOT NULL))
);
CREATE INDEX connector_pending_setups_expiry ON public.connector_pending_setups(expires_at)
 WHERE status IN ('pending_auth','pending_review','ready');
-- Neither ciphertext nor provider evidence is visible through owner RLS.
CREATE TABLE public.connector_setup_staged_credentials (
  setup_id uuid PRIMARY KEY REFERENCES public.connector_pending_setups(id) ON DELETE CASCADE,
  encrypted_payload bytea NOT NULL
);
CREATE FUNCTION public.guard_connector_pending_setup() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF ROW(NEW.id,NEW.actor_user_id,NEW.workspace_id,NEW.provider,NEW.intent,NEW.policy_revision,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.actor_user_id,OLD.workspace_id,OLD.provider,OLD.intent,OLD.policy_revision,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'connector_setup_intent_immutable';
  END IF;
  IF OLD.status IN ('active','stale','failed','cancelled','expired') THEN
    RAISE EXCEPTION 'connector_setup_terminal';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='pending_auth' AND NEW.status='pending_review') OR
    (OLD.status='pending_review' AND NEW.status='ready') OR
    (OLD.status='ready' AND NEW.status='active') OR
    NEW.status IN ('stale','failed','cancelled','expired')) THEN
    RAISE EXCEPTION 'connector_setup_transition_invalid';
  END IF;
  IF OLD.nonce_hash IS NULL AND NEW.nonce_hash IS NOT NULL THEN RAISE EXCEPTION 'connector_setup_nonce_reused'; END IF;
  NEW.version := OLD.version+1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_pending_setup_guard BEFORE UPDATE ON public.connector_pending_setups
 FOR EACH ROW EXECUTE FUNCTION public.guard_connector_pending_setup();
ALTER TABLE public.connector_pending_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_pending_setups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connector_setup_staged_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_setup_staged_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_setup_owner_read ON public.connector_pending_setups FOR SELECT USING (
 actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
 AND (workspace_id IS NULL OR EXISTS (SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id=connector_pending_setups.workspace_id AND m.user_id=actor_user_id)));
CREATE POLICY connector_setup_system ON public.connector_pending_setups FOR ALL
 USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');
CREATE POLICY connector_setup_credentials_system ON public.connector_setup_staged_credentials FOR ALL
 USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');
REVOKE ALL ON FUNCTION public.guard_connector_pending_setup() FROM PUBLIC;
COMMIT;
