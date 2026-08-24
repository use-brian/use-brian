-- Feishu/Lark passive group ingest has two narrower gates after this global
-- capability: an admin-owned chat allowlist and a matching ingest rule. Adding
-- the capability to existing rows is therefore safe and remains default-drop.

BEGIN;

UPDATE channels
SET enabled_capabilities = array_append(enabled_capabilities, 'ingest')
WHERE channel_type = 'feishu'
  AND NOT ('ingest' = ANY (enabled_capabilities));

COMMIT;
