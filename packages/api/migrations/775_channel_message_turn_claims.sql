BEGIN;

-- Internal at-most-once turn admission. Passive persistence does not consume
-- an assistant's turn; explicitly addressing a second bot remains possible.
CREATE TABLE channel_message_turn_claims (
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  channel_message_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, assistant_id, channel_message_id)
);

COMMIT;
