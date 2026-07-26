-- 373_drop_modes_approvals_snapshots_cl9_shadow_claim.sql
--
-- Second teardown wave (follows 371's sharing_mode/discovery cut). Every
-- table dropped here was structurally starved or dark:
--
-- 1. assistant_modes + assistant_connections.mode_id — after 371 no reachable
--    consult path ever resolved a non-null mode: same-workspace consults are
--    full-trust, and the follow() writer that could create the cross-workspace
--    connections modes bound to was already removed. The Network tab's mode
--    CRUD wrote rows with zero runtime effect. The transport/executor/UI mode
--    apparatus is removed in the same change.
--
-- 2. assistant_pending_messages — the requireApproval consult queue. Its only
--    writers were the mode approval branch (starved, see #1) and the
--    resolveDataRequest approve path (only reachable FROM an approval). All
--    readers (buildPendingContext, reviewDataRequest, /api/pending-messages)
--    removed in the same change.
--
-- 3. sharing_snapshots — snapshot-freshness consult responses. Only mattered
--    on a snapshot-mode connection (starved, see #1) and the owner-facing
--    generate/publish surface had no UI, so no snapshot could ever be
--    published. Store/routes/publishSnapshot tool removed in the same change.
--
-- 4. retrieval_miss + kb_gap_candidate — the CL-9 chain. The detector wrote a
--    retrieval_miss row per qualifying chat turn, but the aggregator that
--    consumed them (CL9_AGGREGATOR_ENABLED) was never enabled anywhere, so
--    the table only ever accumulated and the KB-gaps UI was permanently
--    empty. Detector, aggregator, /api/kb-gaps, and the gaps UI are removed
--    in the same change.
--
-- 5. shadow_claim_tokens — the partner-mediated shadow-claim flow. Fully
--    wired but no first-party surface ever initiated it and no analytics
--    event suggests it ever ran. Mint/consume routes + consent page removed
--    in the same change.
--
-- 6. workflows.digested_at / digest_verdict — bookkeeping for the
--    WORKFLOW_LIFECYCLE_ENABLED sweep worker, which shipped dark (flag never
--    set in any deployment) and is retired in the same change. The lifecycle
--    state columns themselves STAY: the spent one-off schedule auto-archive
--    (mig 369) and the PATCH 'active' restore path are live.

BEGIN;

-- #1 — the FK column first, then the table it points at.
ALTER TABLE public.assistant_connections DROP COLUMN IF EXISTS mode_id;
DROP TABLE IF EXISTS public.assistant_modes;

-- #2
DROP TABLE IF EXISTS public.assistant_pending_messages;

-- #3
DROP TABLE IF EXISTS public.sharing_snapshots;

-- #4
DROP TABLE IF EXISTS public.retrieval_miss;
DROP TABLE IF EXISTS public.kb_gap_candidate;

-- #5
DROP TABLE IF EXISTS public.shadow_claim_tokens;

-- #6
ALTER TABLE public.workflows DROP COLUMN IF EXISTS digested_at;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS digest_verdict;

COMMIT;
