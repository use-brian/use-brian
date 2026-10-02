BEGIN;

CREATE TABLE live_interaction_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rule text NOT NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE live_interaction_captures (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,
  chat_session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  pending jsonb,
  detector_token uuid,
  detector_until timestamptz,
  detector_retry timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_interaction_capture_scope
  ON live_interaction_captures (owner_id, workspace_id, chat_session_id);

-- Immutable ASR finals. The client/provider item identity deduplicates uploads;
-- previous_id orders reconnect/out-of-order delivery independently of arrival.
CREATE TABLE live_interaction_utterances (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  capture_id uuid NOT NULL REFERENCES live_interaction_captures(id) ON DELETE CASCADE,
  id text NOT NULL,
  source text NOT NULL CHECK (source IN ('microphone', 'system')),
  previous_id text,
  data jsonb NOT NULL,
  rule text NOT NULL,
  rule_version integer NOT NULL,
  processed boolean NOT NULL DEFAULT false,
  detector_attempts integer NOT NULL DEFAULT 0 CHECK (detector_attempts BETWEEN 0 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_id, id)
);
CREATE INDEX live_interaction_inbox
  ON live_interaction_utterances (capture_id, cursor) WHERE NOT processed;

-- occurrence_index permits multiple wake/question pairs in one ASR final.
CREATE TABLE live_interaction_jobs (
  id uuid PRIMARY KEY,
  capture_id uuid NOT NULL REFERENCES live_interaction_captures(id) ON DELETE CASCADE,
  occurrence bigint NOT NULL REFERENCES live_interaction_utterances(cursor) ON DELETE CASCADE,
  occurrence_index integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_id, occurrence, occurrence_index)
);
CREATE INDEX live_interaction_queue ON live_interaction_jobs (status, available_at);
CREATE INDEX live_interaction_capture_jobs ON live_interaction_jobs (capture_id, status);

-- Owner-pool only: all access goes through the injected authorization boundary.
ALTER TABLE live_interaction_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_interaction_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_interaction_utterances ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_interaction_jobs ENABLE ROW LEVEL SECURITY;

COMMIT;
