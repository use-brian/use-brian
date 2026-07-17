-- Claim ledger for the grounding gate (v2): every figure claim in a shipped
-- interactive reply, with its evidence linkage — which tool result backed
-- it, or 'unverified'. Written by the chat / channel pipelines right after
-- the assistant message row is persisted (before the channel send); read by
-- the dispute pre-pass, which loads the previous reply's claims when the
-- user disputes a figure. System-pool access only (written and read inside
-- the server pipelines, no user-facing route) — no RLS, like
-- chat_turn_locks. Rows die with their message via ON DELETE CASCADE.
--
-- Spec: docs/architecture/engine/grounding-gate.md → "Claim ledger".

BEGIN;

CREATE TABLE claim_provenance (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_message_id    uuid NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
    claim                 text NOT NULL,
    canonical             text NOT NULL,
    kind                  text NOT NULL CHECK (kind IN ('amount', 'percent', 'date')),
    status                text NOT NULL CHECK (status IN ('backed', 'unverified')),
    backed_by_tool_use_id text,
    backed_by_tool_name   text,
    created_at            timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_claim_provenance_message ON claim_provenance(session_message_id);

COMMIT;
