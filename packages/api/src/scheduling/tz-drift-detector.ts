/**
 * Travel-tz drift detector.
 *
 * Reads `analytics_events.metadata.client_tz` — stamped by the auth
 * middleware on session_started (see
 * `packages/api/src/auth/client-timezone.ts`) — over a rolling 48h
 * window and decides whether the user has probably moved to a new
 * timezone. When it fires, callers (chat-route injection or the web
 * Tasks tab) present the user with per-job options: Keep / Rebase /
 * Switch-to-follow-me / Pause.
 *
 * Design notes:
 *   - **No ≥N sessions threshold.** Many users — especially on
 *     Telegram — stay in a single session forever. The detector
 *     only cares about observation count and recency.
 *   - **Flapping guard.** Users on VPN / with multiple devices can
 *     see their observed tz bounce. If the past 7 days contain
 *     ≥ 3 distinct daily-top tzs, we suppress entirely — the signal
 *     is too chaotic to act on.
 *   - **Mode-agnostic.** Jobs already in `mode='user'` need no
 *     action; the detector filters on `mode='local'` pinned jobs.
 *   - **No new table.** Analytics is the source of truth. Retention
 *     is inherited from whatever lifecycle already exists for
 *     `analytics_events`.
 *
 * Component tag: [COMP:api/tz-drift-detector].
 * Plan: `/Users/whatever/.claude/plans/starry-prancing-llama.md` → Phase 4.
 */

import { query } from '../db/client.js'
import { findUserById } from '../db/users.js'

export type TzDriftResult = {
  /** The IANA zone the user appears to be in now. */
  suggestedTz: string
  /** The user's currently-stored tz (what `users.timezone` says). */
  currentTz: string
  /** Count of client_tz observations for `suggestedTz` in the 48h window. */
  observationCount: number
  /** Active, local-mode jobs that would be affected. */
  pinnedJobs: Array<{
    id: string
    instructions: string
    timezone: string
  }>
}

type Clock = { now(): Date }
const realClock: Clock = { now: () => new Date() }

export type DriftDetectorDeps = {
  /**
   * Optional clock override for tests. Production leaves this undefined
   * and relies on `now()` in the SQL and JS sides.
   */
  clock?: Clock
}

/**
 * Run the detector for a user. Returns the nudge payload when all fire
 * conditions are met, or null when the user is stable / suppressed /
 * flapping. See inline comments for the exact predicates.
 */
export async function detectTzDrift(
  userId: string,
  deps: DriftDetectorDeps = {},
): Promise<TzDriftResult | null> {
  const clock = deps.clock ?? realClock

  // 1. Suppression window still active? Short-circuit before touching
  //    analytics. `getTzNudgeSuppression` returns null when never set.
  const user = await findUserById(userId)
  if (!user) return null
  const currentTz = user.timezone ?? 'UTC'

  const suppressionResult = await query<{ suppressed: boolean }>(
    `SELECT (tz_nudge_suppressed_until IS NOT NULL AND tz_nudge_suppressed_until > now()) AS suppressed
       FROM users WHERE id = $1`,
    [userId],
  )
  if (suppressionResult.rows[0]?.suppressed) return null

  // 2. Flapping guard. Reject users whose observed tz is chaotic over
  //    the last week — VPNs, privacy extensions, multi-device. A real
  //    travel event will have at most 2 daily-top tzs (home + trip).
  const flappingResult = await query<{ distinct_tops: number }>(
    `WITH daily AS (
       SELECT date_trunc('day', created_at) AS d,
              mode() WITHIN GROUP (ORDER BY metadata->>'client_tz') AS day_tz
         FROM analytics_events
        WHERE user_id = $1
          AND created_at > now() - interval '7 days'
          AND metadata ? 'client_tz'
        GROUP BY d
     )
     SELECT COUNT(DISTINCT day_tz)::int AS distinct_tops FROM daily WHERE day_tz IS NOT NULL`,
    [userId],
  )
  if ((flappingResult.rows[0]?.distinct_tops ?? 0) >= 3) return null

  // 3. Dominant tz in the 48h window. Order by count (desc) then most-
  //    recent observation to tie-break on currency. `latest` decides
  //    whether the signal is still fresh enough to be actionable.
  const countsResult = await query<{
    tz: string
    n: number
    latest: Date
  }>(
    `SELECT metadata->>'client_tz' AS tz,
            COUNT(*)::int AS n,
            MAX(created_at) AS latest
       FROM analytics_events
      WHERE user_id = $1
        AND created_at > now() - interval '48 hours'
        AND metadata ? 'client_tz'
      GROUP BY 1
      ORDER BY n DESC, latest DESC`,
    [userId],
  )
  const top = countsResult.rows[0]
  if (!top) return null
  if (top.tz === currentTz) return null
  if (top.n < 3) return null

  // 4. Freshness: the dominant tz must still be "current" (observed in
  //    the last 6h). Otherwise the user may have already left that zone
  //    and this is stale signal.
  const latestMs = new Date(top.latest).getTime()
  const sixHoursAgoMs = clock.now().getTime() - 6 * 60 * 60 * 1000
  if (latestMs < sixHoursAgoMs) return null

  // 5. The user must not have bounced back to their currentTz recently
  //    (last 24h). A user who flew to Tokyo for lunch and came home
  //    should not be nudged.
  const bounceResult = await query<{ seen_home: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM analytics_events
        WHERE user_id = $1
          AND created_at > now() - interval '24 hours'
          AND metadata ? 'client_tz'
          AND metadata->>'client_tz' = $2
     ) AS seen_home`,
    [userId, currentTz],
  )
  if (bounceResult.rows[0]?.seen_home) return null

  // 6. The user must own at least one active, local-mode job. Otherwise
  //    there's nothing to nudge about.
  const jobsResult = await query<{
    id: string
    instructions: string
    timezone: string
  }>(
    `SELECT id, instructions, timezone
       FROM scheduled_jobs
      WHERE user_id = $1 AND enabled = true AND mode = 'local'
      ORDER BY created_at DESC`,
    [userId],
  )
  if (jobsResult.rows.length === 0) return null

  return {
    suggestedTz: top.tz,
    currentTz,
    observationCount: top.n,
    pinnedJobs: jobsResult.rows.map((r) => ({
      id: r.id,
      instructions: r.instructions,
      timezone: r.timezone,
    })),
  }
}
