-- [COMP:api/channel-recording] Provider-visible bot attribution, never private assistant metadata.
ALTER TABLE session_messages ADD COLUMN published_sender_name text;
COMMENT ON COLUMN session_messages.published_sender_name IS
 'NULL for ordinary rows; non-NULL for provider-published external assistant text. Empty string requests a neutral localized Assistant label.';
