-- Native-only capability. Generic UsageStore and non-native OSS writes are unchanged.
-- No foreign keys to mutable identities, native sessions or the deletable COGS
-- ledger: this is the deletion tombstone preventing recharging a committed key.
-- Contains bounded accounting metadata only. Purging these tombstones requires
-- an explicit retention/replay policy; absence of a ledger row is NOT permission
-- to recharge. No automatic purge or reconciliation worker is enabled here.
BEGIN;
CREATE TABLE native_computer_billing_intents (
 session_id uuid NOT NULL,
 attempt_id uuid NOT NULL,
 version integer NOT NULL CHECK (version=1),
 backend text NOT NULL CHECK (backend='oss-native-v1'),
 admission jsonb NOT NULL CHECK (jsonb_typeof(admission)='object'),
 admission_hash text NOT NULL CHECK (admission_hash ~ '^[a-f0-9]{64}$'),
 intent jsonb CHECK (jsonb_typeof(intent)='object'),
 intent_hash text CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK (state IN ('admitted','prepared','blocked','recorded')),
 conflicted boolean NOT NULL DEFAULT false,
 blocked_reason text CHECK (blocked_reason IN ('attribution_missing','audit_missing','audit_conflict','intent_conflict')),
 ledger_id uuid,
 stored_amount_usd numeric(18,10) CHECK (stored_amount_usd >= 0 AND stored_amount_usd < 100000000),
 receipt jsonb CHECK (jsonb_typeof(receipt)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (session_id,attempt_id),
 UNIQUE (ledger_id),
 CHECK ((intent IS NULL) = (intent_hash IS NULL)),
 CHECK ((state='admitted') = (intent IS NULL)),
 CHECK ((state='recorded') = (receipt IS NOT NULL)),
 CHECK ((state='recorded') = (ledger_id IS NOT NULL)),
 CHECK ((state='recorded') = (stored_amount_usd IS NOT NULL)),
 CHECK ((state='blocked') = (blocked_reason IS NOT NULL))
);
CREATE INDEX native_computer_billing_ready ON native_computer_billing_intents(updated_at,session_id,attempt_id)
 WHERE state='prepared' AND NOT conflicted;

CREATE FUNCTION guard_native_billing_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.session_id,NEW.attempt_id,NEW.version,NEW.backend,NEW.admission,NEW.admission_hash)
      IS DISTINCT FROM ROW(OLD.session_id,OLD.attempt_id,OLD.version,OLD.backend,OLD.admission,OLD.admission_hash)
    OR (OLD.intent IS NOT NULL AND ROW(NEW.intent,NEW.intent_hash) IS DISTINCT FROM ROW(OLD.intent,OLD.intent_hash))
    OR (OLD.receipt IS NOT NULL AND ROW(NEW.receipt,NEW.ledger_id,NEW.stored_amount_usd,NEW.state)
      IS DISTINCT FROM ROW(OLD.receipt,OLD.ledger_id,OLD.stored_amount_usd,OLD.state))
    OR (OLD.conflicted AND NOT NEW.conflicted) THEN
   RAISE EXCEPTION 'Native accounting immutable metadata conflict';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_billing_intent_immutable BEFORE UPDATE ON native_computer_billing_intents
 FOR EACH ROW EXECUTE FUNCTION guard_native_billing_intent();
COMMENT ON TABLE native_computer_billing_intents IS
 'Native admission, immutable priced intent, and historical insertion receipt. Receipts survive identity/ledger/session deletion. Not payment or provider-drain evidence.';
COMMIT;
