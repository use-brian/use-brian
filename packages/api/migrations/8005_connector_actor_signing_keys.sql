BEGIN;

CREATE TABLE connector_actor_signing_keys (
  kid text PRIMARY KEY CHECK(kid ~ '^[A-Za-z0-9_-]{1,128}$'),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048 AND issuer LIKE 'https://%'),
  encrypted_private_key bytea NOT NULL CHECK(octet_length(encrypted_private_key)>28),
  public_jwk jsonb NOT NULL CHECK(jsonb_typeof(public_jwk)='object'
    AND public_jwk ?& ARRAY['kid','kty','crv','alg','use','x']
    AND public_jwk->>'kid'=kid AND public_jwk->>'kty'='OKP' AND public_jwk->>'crv'='Ed25519'
    AND public_jwk->>'alg'='EdDSA' AND public_jwk->>'use'='sig'
    AND public_jwk->>'x' ~ '^[A-Za-z0-9_-]{43}$'
    AND public_jwk-ARRAY['kid','kty','crv','alg','use','x']='{}'::jsonb),
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','retiring','revoked')),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  retain_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((status='active' AND retired_at IS NULL AND retain_until IS NULL AND revoked_at IS NULL)
    OR (status='retiring' AND retired_at IS NOT NULL AND retain_until IS NOT NULL AND retain_until>=retired_at+interval '65 seconds' AND revoked_at IS NULL)
    OR (status='revoked' AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX connector_actor_one_active_key ON connector_actor_signing_keys(issuer) WHERE status='active';
ALTER TABLE connector_actor_signing_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_actor_signing_keys FROM PUBLIC;

CREATE TABLE connector_actor_key_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kid text NOT NULL REFERENCES connector_actor_signing_keys(kid),
  operation text NOT NULL CHECK(operation IN('created','retiring','revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE connector_actor_key_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_actor_key_events FROM PUBLIC;

CREATE FUNCTION guard_connector_actor_signing_key() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'connector actor keys are retained' USING ERRCODE='22023'; END IF;
  IF (NEW.kid,NEW.issuer,NEW.encrypted_private_key,NEW.public_jwk,NEW.valid_from,NEW.created_at)
    IS DISTINCT FROM (OLD.kid,OLD.issuer,OLD.encrypted_private_key,OLD.public_jwk,OLD.valid_from,OLD.created_at)
    OR OLD.status='revoked' OR OLD.status='retiring' AND NEW.status NOT IN('retiring','revoked')
    OR OLD.retired_at IS NOT NULL AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.retain_until IS DISTINCT FROM OLD.retain_until)
    OR OLD.status='active' AND NEW.status='active' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'connector actor key binding is immutable' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_actor_key_immutable BEFORE UPDATE OR DELETE ON connector_actor_signing_keys
  FOR EACH ROW EXECUTE FUNCTION guard_connector_actor_signing_key();

CREATE FUNCTION audit_connector_actor_key() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN INSERT INTO connector_actor_key_events(kid,operation) VALUES(NEW.kid,'created');
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN INSERT INTO connector_actor_key_events(kid,operation) VALUES(NEW.kid,NEW.status); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION audit_connector_actor_key() FROM PUBLIC;
CREATE TRIGGER connector_actor_key_audit AFTER INSERT OR UPDATE ON connector_actor_signing_keys
  FOR EACH ROW EXECUTE FUNCTION audit_connector_actor_key();
CREATE TRIGGER connector_actor_key_events_immutable BEFORE UPDATE OR DELETE ON connector_actor_key_events
  FOR EACH ROW EXECUTE FUNCTION application_receipt_immutable();

CREATE FUNCTION connector_actor_public_jwks(configured_issuer text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('keys',coalesce(jsonb_agg(public_jwk ORDER BY created_at,kid),'[]'::jsonb))
    FROM connector_actor_signing_keys WHERE issuer=configured_issuer AND valid_from<=statement_timestamp()
      AND (status='active' OR status='retiring' AND retain_until>statement_timestamp())
$$;
REVOKE ALL ON FUNCTION connector_actor_public_jwks(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    REVOKE ALL ON connector_actor_signing_keys,connector_actor_key_events FROM app_user;
    GRANT EXECUTE ON FUNCTION connector_actor_public_jwks(text) TO app_user;
  END IF;
END $$;

COMMIT;
