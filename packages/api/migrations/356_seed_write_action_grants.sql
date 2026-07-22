-- 356: Behavior-preserving seed for the connector write-grant gate expansion.
--
-- Before this change, `assertActionAllowed` was enforced only for
-- gmailSendMessage and the three GCal event actions. The gate now covers
-- EVERY registry-classified write tool of the official external connectors
-- (github, notion, agentmail, gdrive, and gcal's Google Tasks writes) via
-- `gateToolsOnActionGrants`. Without a seed, turning enforcement on would
-- silently revoke write capabilities that shipped features already rely on
-- (Slides deck generation, Sheets logging, GitHub issue filing, ...).
--
-- Seed rule: every EXISTING assistant that has NO grant row for a connector
-- gets one carrying exactly the previously-ungated write tools, so runtime
-- behavior is unchanged on deploy. Assistants that already have a row for a
-- connector expressed explicit intent in Studio; their action list is
-- preserved (gcal rows only gain the Google Tasks writes, which were not
-- governable before). Assistants created AFTER this migration get no rows:
-- the documented deny-by-default posture applies to them in full.
--
-- `granted_by_user_id` is attributed to the assistant owner, falling back to
-- the workspace owner; assistants with neither (orphans) are skipped.
--
-- See docs/architecture/integrations/connector-actions.md
-- -> "Per-assistant capability grants".

BEGIN;

INSERT INTO assistant_connector_grants
  (assistant_id, connector_id, read_allowed, allowed_actions, granted_by_user_id)
SELECT
  a.id,
  seed.connector_id,
  true,
  seed.actions,
  COALESCE(a.owner_user_id, w.owner_user_id)
FROM assistants a
LEFT JOIN workspaces w ON w.id = a.workspace_id
CROSS JOIN (
  VALUES
    ('github',    ARRAY['githubCreateIssue', 'githubCreateIssueComment', 'githubWriteFile']),
    ('notion',    ARRAY['notionCreatePage', 'notionUpdatePage', 'notionAppendBlocks']),
    ('agentmail', ARRAY['agentmailSendMessage', 'agentmailCreateDraft']),
    ('gdrive',    ARRAY[
      'googleDocsAppendText', 'googleDocsReplaceText', 'googleDocsCreate',
      'googleSheetsWriteRange', 'googleSheetsAppendRows', 'googleSheetsCreate',
      'googleSheetsFormat', 'googleSheetsBatchUpdate',
      'googleSlidesCreateSlide', 'googleSlidesUpdateSlideContent', 'googleSlidesInsertImage',
      'googleSlidesDeleteSlide', 'googleSlidesReorderSlides', 'googleSlidesDuplicateSlide',
      'googleSlidesBatchUpdate', 'googleSlidesCreatePresentation'
    ]),
    -- gcal rows seeded here carry ONLY the Tasks writes: the three event
    -- actions were already gated pre-migration, so their absence is the
    -- existing (deliberate) deny state for assistants without a row.
    ('gcal',      ARRAY['googleTasksCreateTask', 'googleTasksUpdateTask', 'googleTasksDeleteTask'])
) AS seed (connector_id, actions)
WHERE COALESCE(a.owner_user_id, w.owner_user_id) IS NOT NULL
ON CONFLICT (assistant_id, connector_id) DO NOTHING;

-- Existing gcal grant rows (owners who checked event boxes in Studio) gain
-- the Google Tasks writes, which were ungated before this migration.
UPDATE assistant_connector_grants g
SET allowed_actions = (
      SELECT array_agg(DISTINCT t)
      FROM unnest(g.allowed_actions
        || ARRAY['googleTasksCreateTask', 'googleTasksUpdateTask', 'googleTasksDeleteTask']) AS t
    ),
    updated_at = now()
WHERE g.connector_id = 'gcal'
  AND NOT g.allowed_actions @> ARRAY['googleTasksCreateTask', 'googleTasksUpdateTask', 'googleTasksDeleteTask'];

COMMIT;
