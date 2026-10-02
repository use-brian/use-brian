-- Detached metadata (including user/workspace deletion) is retained for device reconciliation.
-- Audit follows the retained session and cascades only on explicit session purge.
-- Metadata only. Native tokens, AX/text/frame content and grant goals are never stored.
CREATE TABLE native_computer_sessions (
 id uuid PRIMARY KEY,
 user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 auth_session_id uuid REFERENCES auth_sessions(id) ON DELETE SET NULL,
 workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
 assistant_id uuid REFERENCES assistants(id) ON DELETE SET NULL,
 conversation_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
 device_id text NOT NULL,
 deployment_id text NOT NULL,
 challenge text NOT NULL,
 grant_id text,
 run_state text CHECK (run_state IN ('running','finished','execution_unknown')),
 epoch integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'awaiting_local_consent',
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz
);
CREATE UNIQUE INDEX native_computer_device_lease ON native_computer_sessions(deployment_id,device_id) WHERE revoked_at IS NULL OR state='execution_unknown' OR run_state IN ('running','execution_unknown');
CREATE TABLE native_computer_audit (
 id bigserial PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES native_computer_sessions(id) ON DELETE CASCADE,
 event text NOT NULL CHECK (event IN ('created','paired','revoked','action')),
 command_id text,
 action_kind text,
 outcome text CHECK (outcome IN ('not_executed','executed','execution_unknown')),
 code text,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX native_computer_conversation_lease ON native_computer_sessions(user_id,conversation_id) WHERE revoked_at IS NULL;

-- Accounting metadata, NOT the non-refundable worst-case reservation ledger.
-- NULL usage/cost means unknown (including failed or partial streams).
CREATE TABLE native_computer_inference_attempts (
 id bigserial PRIMARY KEY,
 attempt_id uuid NOT NULL,
 -- Pending survives logical task return; never infer drained calls from run_state.
 invocation_state text NOT NULL CHECK (invocation_state IN ('pending','settled')),
 interrupted boolean NOT NULL,
 billing_state text NOT NULL DEFAULT 'unclaimed' CHECK (billing_state IN ('unclaimed','claimed','recorded','unknown','not_required')),
 UNIQUE (session_id,attempt_id),
 session_id uuid NOT NULL REFERENCES native_computer_sessions(id) ON DELETE CASCADE,
 requested_model varchar(200) NOT NULL,
 -- Only provider-reported resolution; missing message_start remains NULL.
 model varchar(200),
 provider_kind text NOT NULL CHECK (provider_kind IN ('custom','openai','anthropic','gemini','openrouter','typesafe','other')),
 lane text NOT NULL CHECK (lane IN ('text','vision','decision')),
 operation text CHECK (operation IN ('plan','decompose','next-action','verify-progress','ground')),
 stage text NOT NULL CHECK (stage IN ('direct','primary_decision','llm_only','generation','uncertainty_review','operational_failover','shadow_legacy')),
 perception_path text NOT NULL CHECK (perception_path IN ('ax','vision')),
 CHECK (perception_path = CASE WHEN lane='vision' THEN 'vision' ELSE 'ax' END),
 -- NULL means unknown, 'none' means known not to be a follow-up.
 fallback_reason text CHECK (fallback_reason IN ('none','generation_required','uncertain','inconsistent')),
 disposition text CHECK (disposition IN ('complete','follow_up','unavailable')),
 outcome text NOT NULL CHECK (outcome IN ('pending','ok','failed')),
 duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
 usage jsonb CHECK (usage IS NULL OR jsonb_typeof(usage)='object'),
 incurred_cost_usd double precision CHECK (incurred_cost_usd >= 0 AND incurred_cost_usd < 'Infinity'::float8),
 -- Estimated charge is not confirmation of the separate UsageStore write.
 estimated_billed_cost_usd double precision CHECK (estimated_billed_cost_usd >= 0 AND estimated_billed_cost_usd < 'Infinity'::float8),
 billed_cost_usd double precision CHECK (billed_cost_usd >= 0 AND billed_cost_usd < 'Infinity'::float8),
 provider_key_source text NOT NULL CHECK (provider_key_source IN ('user','platform')),
 diagnostic_code text CHECK (diagnostic_code IN ('inference_failed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE native_computer_inference_attempts
 ADD CHECK ((billing_state='recorded') = (billed_cost_usd IS NOT NULL)),
 ADD CHECK (billing_state NOT IN ('claimed','recorded','not_required') OR (invocation_state='settled' AND usage IS NOT NULL AND model IS NOT NULL)),
 ADD CHECK (billing_state <> 'not_required' OR (provider_key_source='user' AND estimated_billed_cost_usd=0));
CREATE INDEX native_computer_inference_session ON native_computer_inference_attempts(session_id,created_at);
