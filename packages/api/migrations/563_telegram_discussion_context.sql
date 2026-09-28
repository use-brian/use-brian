BEGIN;
-- Provider-visible source material, not authored conversation history. Internal
-- webhook-only access; integration FK is the tenant boundary and deletion scope.
CREATE TABLE telegram_channel_posts (
  integration_id uuid NOT NULL REFERENCES channel_integrations(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  message_id text NOT NULL,
  content text,
  PRIMARY KEY (integration_id, chat_id, message_id)
);
CREATE TABLE telegram_discussion_roots (
  integration_id uuid NOT NULL REFERENCES channel_integrations(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  root_id text NOT NULL,
  source_chat_id text,
  source_message_id text,
  content text,
  PRIMARY KEY (integration_id, chat_id, root_id),
  CHECK (source_message_id IS NULL OR source_chat_id IS NOT NULL)
);
ALTER TABLE telegram_channel_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_discussion_roots ENABLE ROW LEVEL SECURITY;
COMMIT;
