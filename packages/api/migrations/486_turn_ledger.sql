-- Turn ledger — the append-only capture substrate for turn audit, replay
-- evals, and the epoch cut (docs/plans/turn-ledger-and-brain-history.md §4).
--
-- turn_events rows are POINTER-ONLY by design: shape in `metadata`, content
-- exclusively behind content hashes in `payload_refs` resolving through
-- turn_payloads to object storage. Graded by
-- `invariants/turn-events-pointer-only`.
--
-- Writes are system-level (recording happens under the engine, before any
-- user-scoped GUC is relevant, and a ledger write must never fail a turn);
-- reads are gated at the route layer by workspace membership, per the
-- memory_recall_events precedent. RLS is enabled with no member policy.

BEGIN;

CREATE TABLE turn_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID,
  assistant_id          UUID,
  session_id            UUID,
  -- Trace key: the persisted assistant message id when the lane has one,
  -- else a recorder-minted UUID. TEXT, not FK — traces outlive sessions and
  -- exist for lanes with no session_messages row (workers, synthesis).
  assistant_message_id  TEXT NOT NULL,
  step_ordinal          INTEGER NOT NULL CHECK (step_ordinal >= 0),
  actor                 TEXT NOT NULL CHECK (actor IN ('assistant_turn','consolidation_run','human_edit','workflow_step','a2a')),
  kind                  TEXT NOT NULL CHECK (kind IN ('provider_call','tool_call','retrieval','confirmation','approval','mutation')),
  -- Small, shape-only. Content NEVER rides here — that is what payload_refs
  -- exists for.
  metadata              JSONB NOT NULL DEFAULT '{}',
  payload_refs          TEXT[] NOT NULL DEFAULT '{}',
  sensitivity           TEXT NOT NULL DEFAULT 'internal',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assistant_message_id, step_ordinal)
);

CREATE INDEX idx_turn_events_session ON turn_events (session_id, created_at);
CREATE INDEX idx_turn_events_workspace ON turn_events (workspace_id, created_at);

ALTER TABLE turn_events ENABLE ROW LEVEL SECURITY;

-- Content-addressed payload index. Bytes live in object storage (GCS / BYO /
-- local disk) under `ledger/<scope>/<hash>`; this table is the dedup index +
-- erasure ledger. `scope` is the workspace id as text, or 'global' for the
-- rare workspace-less lane — part of the key so identical content in two
-- workspaces never shares a row or an object (privacy over dedup).
CREATE TABLE turn_payloads (
  scope         TEXT NOT NULL,
  hash          TEXT NOT NULL,
  workspace_id  UUID,
  byte_size     BIGINT NOT NULL CHECK (byte_size >= 0),
  media_type    TEXT NOT NULL DEFAULT 'application/json',
  storage_ref   TEXT NOT NULL,
  sensitivity   TEXT NOT NULL DEFAULT 'internal',
  -- Erasure tombstone (plan §7): the object is deleted, the index row
  -- remains so as-of reads resolve to an explicit erased marker, never
  -- silent absence.
  erased_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, hash)
);

ALTER TABLE turn_payloads ENABLE ROW LEVEL SECURITY;

-- The epoch cut (plan §3): one row, stamped when this migration runs.
-- Turns before it render through the legacy adapter (`fidelity: 'legacy'`);
-- turns after it have full ledger traces. Constant-of-record, not an env var.
CREATE TABLE ledger_epoch (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  epoch_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ledger_epoch (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
