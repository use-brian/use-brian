-- 414_brand_capability_backfill.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- Grant the `brand` built-in-primitive capability to existing primary and
-- standard assistants.
-- Spec: docs/architecture/features/brand.md → "Capability and governance"
-- Plan: docs/plans/brand-primitive.md D12.
--
-- WHY A BACKFILL AT ALL, GIVEN 412's `files` CARVE-OUT. Migration 412
-- deliberately did NOT backfill `files`, because those tools already carried
-- `requiresCapability: 'files'` — backfilling would have GRANTED file tools to
-- assistants that never had them, which is a behaviour change dressed up as a
-- preservation. `brand` is the opposite case in both halves: the capability is
-- new, so there is nothing to preserve, and `DEFAULT_ON_BUILTIN_CAPABILITIES`
-- (derived from the registry, minus `files`) means every assistant created from
-- here on gets it seeded at creation. Without this backfill the product would
-- have a permanent split: assistants created after today read the brand,
-- assistants created before today silently do not, with nothing in the UI
-- explaining why. The grant is a default, not a lock — an owner revokes it from
-- the assistant's Tools tab like any other built-in primitive.
--
-- SCOPE: `primary` and `standard` only. `app` assistants (doc / feed / mini
-- apps) author their own soul and their tool surface is deliberately narrow;
-- widening it is a per-app decision, not a sweep.
--
-- `granted_by_user_id` is NOT NULL and `assistants.owner_user_id` is nullable
-- (workspace-owned assistants carry no direct owner), so the grantor resolves
-- through the same three-step fallback migration 412 used: the assistant's
-- owner, else whoever granted its earliest existing capability, else the
-- workspace owner. An assistant for which all three are NULL is skipped rather
-- than failing the migration.
--
-- Idempotent: `uniq_active_capability` is a partial unique index on
-- (assistant_id, capability) WHERE revoked_at IS NULL, so a re-run conflicts and
-- does nothing. A grant an owner has since REVOKED is not resurrected by a
-- re-run in any meaningful sense — the conflict target covers active rows only,
-- so a revoked pair would re-insert. That is precisely why this runs once, as a
-- migration, and never as a repeated repair job.
--
-- Filenames are globally unique across BOTH migration dirs (one shared
-- _migrations table). Next free number after this is 415.

BEGIN;

INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id, reason)
SELECT
  a.id,
  'brand',
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
  'built-in primitive - backfilled at brand introduction (migration 414)'
FROM assistants a
WHERE a.kind IN ('primary', 'standard')
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
ON CONFLICT (assistant_id, capability) WHERE revoked_at IS NULL DO NOTHING;

COMMIT;
