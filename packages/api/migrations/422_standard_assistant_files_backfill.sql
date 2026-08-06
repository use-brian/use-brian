-- 422_standard_assistant_files_backfill.sql
--
-- Grant `files` to every existing kind='standard' assistant that has no row
-- for it.
--
-- THIS REVERSES A DELIBERATE DECISION IN MIGRATION 412. That migration
-- backfilled `office` and `computer` and deliberately skipped `files`, on the
-- reasoning that only primaries were ever seeded, so a secondary assistant
-- showing Workspace Files as off "is what has actually been true for them all
-- along", and the new Tools-tab toggle is the remedy. See
-- docs/architecture/features/builtin-primitives.md → "Defaults and the
-- backfill", amended in the same commit as this migration.
--
-- WHY THE REVERSAL
-- ----------------
-- The premise — that an off grant is coherent because the user can see and
-- flip it — holds on the surfaces 412 audited. It does not hold on channels,
-- and channels are where files actually arrive.
--
-- 412's own §3 states the rule: "Policy leaves an incoherent prompt … the
-- assistant is told it has files, told it must persist uploads there, and
-- then fails every call." It fixed that for the L1 blocks, which are
-- capability-keyed. But `cacheInboundImage` is NOT capability-gated: a photo
-- sent to Telegram/WhatsApp/Slack/Discord/Teams/WeChat is cached and the turn
-- carries a promotable `<attached_file id="…">` regardless of any grant. So a
-- files-less standard assistant is still handed a reference with no tool
-- behind it — the exact incoherence 412 set out to remove, on a surface it
-- did not cover.
--
-- Observed 2026-08-05: a standard assistant asked to attach two Telegram
-- photos to a booking email passed both upload ids to
-- `gmailSendMessage(attachments)`, got "not found in this workspace", tried a
-- re-ingest tool, web-searched "how to find workspace file id Use Brian", and
-- sent the email without the photos. 25 of 31 production standard assistants
-- were in that state, and the toggle that would fix it did not exist yet.
--
-- The toggle now exists (412's real contribution), so an owner who wants
-- Workspace Files off can switch it off — and this backfill will not
-- resurrect it, because it inserts only where NO row exists at all, not
-- merely where no ACTIVE row exists. Soft-delete means a revoked row is a
-- decision; skipping those is what makes "default on, revocable" honest in
-- both directions.
--
-- SCOPE
-- -----
-- `kind='standard'` only.
--   - `primary` already seeds `files` at creation and needs nothing.
--   - `app` specialists stay off. That exclusion was always the deliberate
--     one (a distribution app has no business reading workspace files), and
--     nothing here changes it.
-- `views` is deliberately NOT backfilled: the incident evidence is about
--   files, and widening a contested production write past its evidence is how
--   the original drift happened. An owner can toggle `views` on.
--
-- Attribution: the assistant's own owner where it has one, otherwise whoever
-- granted this assistant's earliest existing capability, otherwise the
-- workspace owner. Same COALESCE chain migration 412 established and verified
-- resolves for every assistant row.

BEGIN;

INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id, reason)
SELECT
  a.id,
  'files',
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
  'built-in primitive — backfilled for standard assistants (migration 422)'
FROM assistants a
WHERE a.kind = 'standard'
  AND COALESCE(
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
  -- No row at all, active OR revoked. A revocation is a decision.
  AND NOT EXISTS (
    SELECT 1 FROM assistant_capabilities ac
     WHERE ac.assistant_id = a.id AND ac.capability = 'files'
  );

COMMIT;
