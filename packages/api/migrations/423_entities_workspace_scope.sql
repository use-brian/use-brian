-- Entities are workspace-scoped, not per-principal.
--
-- The 2026-08-07 finding: a public chat link (and any non-member principal)
-- read an EMPTY brain. Two independent gates were closed on the same rows.
-- This migration closes the second one; the first is the `systemRead` change
-- on the `assistant-full` access context (routes/public-turn.ts).
--
-- Gate 2 — visibility was a copy of authorship. `createContact` / `createCompany`
-- / `createDeal` each passed the acting principal as BOTH `user_id` (the
-- visibility axis) and `created_by_user_id` (the authorship axis), so every CRM
-- row landed at `workspace_shared` scope — readable only by the principal who
-- happened to write it. Measured in prod before this migration: 1217 live
-- entities across 20 workspaces, 1217 user-scoped, ZERO workspace-scoped, and
-- `user_id = created_by_user_id` on 100% of rows. A "shared company brain" that
-- was never shared.
--
-- The damage compounds, because agentic and ingest writes act as
-- `billingPartyForAssistant` (the workspace owner), so the owner accumulates a
-- private pile while teammates accumulate theirs. `createContact`'s upsert only
-- searches rows the caller can see, and says so: "an invisible same-name contact
-- belonging to another principal is NOT a merge target; the caller gets their
-- own visible row instead." That is how one workspace ended up with `Ken Lau`
-- twice under two principals. `dedupeEntities` could never find those pairs
-- either — it reads through the caller's access context too
-- (brain/healing-tools.ts), so it was structurally blind to exactly the
-- duplicates this scoping created.
--
-- The fix: entities carry NO visibility partition. `(NULL, NULL)` is the valid
-- workspace scope for this table — the workspace partition plus the sensitivity
-- ladder plus compartments are the gating, which is what
-- docs/architecture/platform/sensitivity.md always intended when it routed
-- "workspace-wide cross-assistant facts" to entities/CRM/KB. The baseline CHECK
-- (000_open_schema_v1.sql:851) forbade exactly that shape, so it is replaced.
--
-- SELF entities are the deliberate exception and keep `user_id`: an
-- `attributes.self = true` row represents a specific human, and nulling it would
-- fuse every member's self-identity into one workspace-wide record. They are
-- already excluded from every CRM list (`NOT (attributes->>'self')::boolean`).
-- The replacement CHECK makes that invariant explicit rather than conventional.
--
-- Authorship is untouched: `created_by_user_id` / `created_by_assistant_id` still
-- stamp who wrote each row, so provenance walks are unaffected. This migration
-- changes who can SEE a row, never who made it.
--
-- Reversible: the down path is `UPDATE entities SET user_id = created_by_user_id`
-- for non-self rows, since visibility was a verbatim copy of authorship.
--
-- Spec: docs/architecture/platform/sensitivity.md → "Entity visibility"
--       docs/architecture/features/public-chat-link.md → "Context scope"
-- [COMP:brain/entity-visibility]

BEGIN;

ALTER TABLE public.entities DROP CONSTRAINT IF EXISTS entities_visibility_check;

-- De-silo every non-self entity. Both axes drop: `user_id` is the bug, and the
-- 138 legacy rows carrying `assistant_id` (product / project / repository /
-- company) are company facts that no single assistant should privately own.
UPDATE public.entities
   SET user_id = NULL,
       assistant_id = NULL
 WHERE NOT COALESCE((attributes->>'self')::boolean, false)
   AND (user_id IS NOT NULL OR assistant_id IS NOT NULL);

-- A self entity must stay bound to its human. This is the only visibility
-- invariant entities still carry.
ALTER TABLE public.entities
  ADD CONSTRAINT entities_self_is_user_scoped
  CHECK (
    NOT COALESCE((attributes->>'self')::boolean, false)
    OR user_id IS NOT NULL
  );

COMMIT;
