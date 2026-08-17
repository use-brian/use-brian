-- Immutable per-key tool ceiling for public chat traffic.
-- Existing keys retain the assistant-governed surface. Newly created external
-- keys default to public_research in the store/route; internal keys require
-- assistant. The DB default preserves old/manual insert behavior.

BEGIN;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS tool_policy TEXT NOT NULL DEFAULT 'assistant';

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_tool_policy_check;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_tool_policy_check
  CHECK (tool_policy IN ('assistant', 'public_research'));

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_public_research_lane_check;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_public_research_lane_check
  CHECK (
    tool_policy <> 'public_research'
    OR (audience = 'external' AND scope = 'chat')
  );

COMMENT ON COLUMN api_keys.tool_policy IS
  'Immutable chat tool ceiling: assistant = assistant-governed surface; public_research = webSearch/urlReader plus Tier memory only.';

COMMIT;
