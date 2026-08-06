-- 412: Built-in primitive OFF switch — backfill the `office` and `computer`
-- capability grants.
--
-- Workspace Files / Office / Computer Use are the `auth_type: 'none'` built-in
-- primitives (BUILTIN_PRIMITIVE_CAPABILITIES). They had no off switch: no
-- credential to revoke, so the connector surfaces rendered a non-interactive
-- "Always on" pill and governance fell back to per-tool allow/ask/block.
--
-- The switch is now the capability grant, so every tool factory in those two
-- groups carries `requiresCapability: 'office' | 'computer'`. That makes the
-- grant load-bearing at runtime: `filterToolsByCapabilities` drops the tools
-- before injection when it is missing. Those tools were previously injected
-- UNCONDITIONALLY, so without this backfill the code change would silently
-- switch Office and Computer Use off for every existing assistant.
--
-- `files` is deliberately NOT backfilled. Its tools already carried
-- `requiresCapability: 'files'`, so the grant already decides who has them —
-- backfilling would GRANT file tools to assistants that do not have them today
-- (only primaries were ever seeded), which is a behaviour change, not a
-- preservation. Secondary assistants therefore show Workspace Files as off,
-- which is what has actually been true for them all along, and the new toggle
-- is what lets an owner turn it on.
--
-- Idempotent: `uniq_active_capability` is a partial unique index on
-- (assistant_id, capability) WHERE revoked_at IS NULL, so a re-run conflicts
-- and does nothing. A grant an owner has since revoked is NOT resurrected —
-- the conflict target only covers active rows, so a revoked row leaves the
-- pair free and would re-insert; that is why this runs once, as a migration,
-- rather than as a repeated repair job.
--
-- `granted_by_user_id` is NOT NULL and `assistants.owner_user_id` is nullable
-- (workspace-owned assistants carry no direct owner), so the grantor is
-- resolved by falling back to whoever granted this assistant's earliest
-- existing capability, then to the assistant's workspace owner. Verified to
-- resolve for every assistant row before writing this migration.
--
-- Spec: docs/architecture/features/builtin-primitives.md

BEGIN;

INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id, reason)
SELECT
  a.id,
  cap.capability,
  COALESCE(
    a.owner_user_id,
    (SELECT ac.granted_by_user_id
       FROM assistant_capabilities ac
      WHERE ac.assistant_id = a.id
      ORDER BY ac.granted_at
      LIMIT 1),
    (SELECT wm.user_id
       FROM workspace_members wm
      WHERE wm.workspace_id = a.workspace_id
      ORDER BY (wm.role = 'owner') DESC, wm.joined_at
      LIMIT 1)
  ),
  'built-in primitive — backfilled at off-switch introduction (migration 412)'
FROM assistants a
CROSS JOIN (VALUES ('office'), ('computer')) AS cap(capability)
WHERE COALESCE(
        a.owner_user_id,
        (SELECT ac.granted_by_user_id
           FROM assistant_capabilities ac
          WHERE ac.assistant_id = a.id
          ORDER BY ac.granted_at
          LIMIT 1),
        (SELECT wm.user_id
           FROM workspace_members wm
          WHERE wm.workspace_id = a.workspace_id
          ORDER BY (wm.role = 'owner') DESC, wm.joined_at
          LIMIT 1)
      ) IS NOT NULL
ON CONFLICT (assistant_id, capability) WHERE revoked_at IS NULL DO NOTHING;

COMMIT;
