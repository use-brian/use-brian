-- One-off backfill: reconstruct usage_tracking rows for public-API
-- turns that were silently rejected by the valid_source CHECK before
-- migration 102 added 'api' to the allowed list.
--
-- Background. From the day the public API shipped until migration 102
-- landed (2026-05), every recordUsage({ source: 'api' }) call from
-- packages/api/src/routes/public-api.ts failed the CHECK and the row
-- was rolled back. The catch block only logged to console.error so the
-- failure was invisible — per-user dashboards showed $0, and the
-- owner's plan budget gate (`checkUsageBudget`, which reads
-- `usage_sessions` + `daily_usage`, both populated by the post-INSERT
-- side-effects in `recordUsage`) saw zero API spend.
--
-- The good news: the `api_request` analytics event WAS written for
-- every turn. Token counts live in `analytics_events.metadata` as
-- `tokens_in` and `tokens_out`. We can reconstruct usage_tracking
-- from those events.
--
-- The not-so-good news: the analytics event does NOT carry the model
-- name, the cache token counts, or the user_message_id. The model is
-- estimated below by joining to the assistant and assuming the public
-- API path resolved to gemini-flash (the budget-`ok` choice for that
-- code path). Cache tokens are zeroed. user_message_id is left NULL.
-- Cost is recomputed using a flat gemini-flash rate.
--
-- This is BEST-EFFORT — the reconstruction is approximate. It's good
-- enough to populate the dashboard's per-user views and the owner's
-- daily_usage rollup; it's not a substitute for what would have been
-- written had the CHECK constraint been right from day one.
--
-- ── Operational notes ──────────────────────────────────────────────
--
-- Idempotency. Each backfilled row is matched to its source
-- analytics_event by `(session_id, created_at within ±10s, source='api')`
-- so re-running the script is a no-op. Safe to run twice.
--
-- Side effects of INSERT. Just inserting rows is NOT enough to
-- backfill `daily_usage` and `usage_sessions` — those are populated
-- by application-level side-effects in `recordUsage`, NOT by SQL
-- triggers. The script below also rebuilds the `daily_usage` rows
-- for the affected (user_id, date) pairs from usage_tracking. We do
-- NOT touch `usage_sessions` (the 5h windows) — those are forward-
-- looking and rebuilding historical sessions has no value.
--
-- Reversibility. Every row inserted carries `model = 'backfill:api'`
-- so a rollback is one DELETE statement (provided at the bottom of
-- this file).
--
-- ── How to run ─────────────────────────────────────────────────────
--
--   # Local
--   psql -d sidanclaw -f packages/api/scripts/backfill-public-api-usage.sql
--
--   # Production (via Cloud SQL Proxy on 5433)
--   URL=$(gcloud secrets versions access latest --secret=DATABASE_URL --project=internal-process-490404 \
--     | sed -E 's|@/sidanclaw\?host=/cloudsql/[^&]+|@127.0.0.1:5433/sidanclaw|')
--   psql "$URL" -f packages/api/scripts/backfill-public-api-usage.sql
--
-- ── Tunables ───────────────────────────────────────────────────────
--
-- gemini-flash pricing per Google's published rates (as of the time
-- this script was written): $0.075 / 1M input tokens, $0.30 / 1M output
-- tokens. Adjust if your actual pricing differs.

BEGIN;

-- 1. Insert reconstructed rows.
WITH reconstructed AS (
  SELECT
    ae.id              AS event_id,
    ae.user_id,
    ae.actor_user_id,
    ae.assistant_id,
    ae.session_id,
    ae.created_at,
    COALESCE((ae.metadata->>'tokens_in')::int,  0) AS input_tokens,
    COALESCE((ae.metadata->>'tokens_out')::int, 0) AS output_tokens
  FROM analytics_events ae
  WHERE ae.event_name = 'api_request'
    AND ae.assistant_id IS NOT NULL
    AND ae.session_id   IS NOT NULL
    -- Skip events that already have a corresponding usage_tracking
    -- row — idempotency check.
    AND NOT EXISTS (
      SELECT 1
      FROM usage_tracking ut
      WHERE ut.session_id = ae.session_id
        AND ut.source = 'api'
        AND ut.created_at BETWEEN ae.created_at - interval '10 seconds'
                              AND ae.created_at + interval '10 seconds'
    )
)
INSERT INTO usage_tracking (
  user_id, actor_user_id, assistant_id, session_id,
  model,
  input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens,
  actual_cost_usd,
  source,
  user_message_id,
  created_at
)
SELECT
  user_id,
  actor_user_id,
  assistant_id,
  session_id,
  'backfill:api'                          AS model,
  input_tokens,
  output_tokens,
  0                                       AS cache_read_tokens,
  0                                       AS cache_write_tokens,
  -- Flat gemini-flash rate (USD per token).
  ROUND(
    (input_tokens  * 0.000000075
   + output_tokens * 0.0000003)::numeric,
    8
  )                                       AS actual_cost_usd,
  'api'                                   AS source,
  NULL::uuid                              AS user_message_id,
  created_at
FROM reconstructed;

-- 2. Rebuild daily_usage for the (user_id, date) pairs touched by
-- the backfill. usage_tracking is the source of truth — daily_usage
-- is just an aggregate, so we delete and re-derive only the pairs
-- that just received new rows. Forward-looking writes will continue
-- to use the live UPSERT path in `recordUsage`.
WITH affected AS (
  SELECT DISTINCT user_id, created_at::date AS date
  FROM usage_tracking
  WHERE source = 'api' AND model = 'backfill:api'
),
rebuilt AS (
  SELECT
    ut.user_id,
    ut.created_at::date AS date,
    SUM(ut.actual_cost_usd) AS total_actual_cost,
    COUNT(*)                AS total_turns
  FROM usage_tracking ut
  JOIN affected a ON a.user_id = ut.user_id AND a.date = ut.created_at::date
  WHERE ut.source NOT LIKE 'overhead:%'
  GROUP BY ut.user_id, ut.created_at::date
)
INSERT INTO daily_usage (user_id, date, total_actual_cost, total_turns)
SELECT user_id, date, total_actual_cost, total_turns
FROM rebuilt
ON CONFLICT (user_id, date) DO UPDATE
  SET total_actual_cost = EXCLUDED.total_actual_cost,
      total_turns       = EXCLUDED.total_turns;

-- 3. Sanity report.
SELECT
  'rows_inserted' AS k,
  COUNT(*)::text  AS v
FROM usage_tracking
WHERE source = 'api' AND model = 'backfill:api'
UNION ALL
SELECT
  'distinct_actors',
  COUNT(DISTINCT actor_user_id)::text
FROM usage_tracking
WHERE source = 'api' AND model = 'backfill:api'
UNION ALL
SELECT
  'total_cost_usd',
  COALESCE(SUM(actual_cost_usd), 0)::text
FROM usage_tracking
WHERE source = 'api' AND model = 'backfill:api';

COMMIT;

-- ── Rollback ──────────────────────────────────────────────────────
--
-- If you need to undo the backfill, run this in a separate session:
--
--   BEGIN;
--   DELETE FROM usage_tracking
--   WHERE source = 'api' AND model = 'backfill:api';
--   -- Then rebuild daily_usage from the remaining rows for the
--   -- affected pairs, same logic as step 2 above.
--   COMMIT;
