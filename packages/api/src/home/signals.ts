/**
 * Home signals assembler — the live source of truth for every NUMBER the
 * "Suggested for you" dock shows. Assembled per request from the brain inbox,
 * approvals, autopilot goals, connector health, workflow run failures,
 * workflows, drafts, and brain counts + growth history. The merge
 * (`mergeHomeDock`, core) folds the assistant's curation artifact over THIS.
 *
 * Every source is wrapped so one failing query degrades to a zero/empty value
 * rather than 500-ing the whole dock — the surface must always render.
 *
 * Aggregate counts use bare `query` (system reads filtered by `workspace_id`);
 * the route gates on `isWorkspaceMember` first, same as the chat-home reads in
 * `home-store.ts`. See docs/architecture/features/home-dock.md.
 *
 * [COMP:api/home-signals]
 */

import { computeNextRun, type HomeSignals, type WorkflowTrigger } from '@use-brian/core'
import type { SavedViewStore } from '@use-brian/core'
import { query } from '../db/client.js'
import { countBrainInbox } from '../db/brain-inbox-store.js'
import { isOssEdition } from '../routes/local-session.js'

const UPCOMING_CAP = 4
const DRAFTS_CAP = 4
const SPARKLINE_DAYS = 14
/** How far back a failed/timeout run still counts as "needs attention". */
const RUN_ATTENTION_WINDOW = '48 hours'

type WorkflowLister = {
  list(
    userId: string,
    workspaceId: string,
  ): Promise<Array<{ id: string; name: string; enabled: boolean; trigger: WorkflowTrigger | null }>>
}

export type HomeSignalsDeps = {
  workflowStore: WorkflowLister
  savedViewStore: SavedViewStore
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.error('[home-signals] source failed, using fallback:', err)
    return fallback
  }
}

export async function assembleHomeSignals(
  userId: string,
  workspaceId: string,
  deps: HomeSignalsDeps,
  now: Date = new Date(),
): Promise<HomeSignals> {
  const [
    review,
    approvalsCount,
    autopilotCount,
    taskTriageCount,
    taskCleanupCount,
    dealAttentionCount,
    connectorAttentionCount,
    workflowAttentionCount,
    brain,
    sparkline,
    workflows,
    drafts,
    hasConnector,
  ] = await Promise.all([
    safe(() => countBrainInbox(workspaceId).then((r) => r.total), 0),
    safe(() => countPendingApprovals(workspaceId), 0),
    safe(() => countAutopilotAttention(workspaceId), 0),
    safe(() => countTaskTriage(workspaceId), 0),
    safe(() => countTaskCleanup(workspaceId), 0),
    safe(() => countDealAttention(workspaceId), 0),
    safe(() => countConnectorAttention(workspaceId), 0),
    safe(() => countWorkflowAttention(workspaceId), 0),
    safe(() => countBrainEntries(workspaceId), { total: 0, last7: 0 }),
    safe(() => brainSparkline(workspaceId, now), [] as number[]),
    safe(() => deps.workflowStore.list(userId, workspaceId), [] as Awaited<ReturnType<WorkflowLister['list']>>),
    safe(
      () => deps.savedViewStore.list({ userId, workspaceId, state: 'draft', limit: DRAFTS_CAP }),
      [] as Awaited<ReturnType<SavedViewStore['list']>>,
    ),
    safe(() => workspaceHasConnector(workspaceId), false),
  ])

  return {
    brainReviewCount: review,
    approvalsCount,
    autopilotCount,
    taskTriageCount,
    taskCleanupCount,
    dealAttentionCount,
    connectorAttentionCount,
    workflowAttentionCount,
    upcomingWorkflows: computeUpcoming(workflows, now),
    recentDrafts: drafts.map((d) => ({
      id: d.id,
      name: d.name,
      updatedAt: d.updatedAt.toISOString(),
    })),
    brainEntryCount: brain.total,
    brainGrowth7d: brain.last7,
    brainSparkline: sparkline,
    onboarding: { hasConnector },
  }
}

/** Soonest-first upcoming scheduled runs for enabled workflows (capped). */
function computeUpcoming(
  workflows: Array<{ id: string; name: string; enabled: boolean; trigger: WorkflowTrigger | null }>,
  now: Date,
): HomeSignals['upcomingWorkflows'] {
  const runs: { id: string; name: string; nextRunAt: string; at: number }[] = []
  for (const wf of workflows) {
    if (!wf.enabled || wf.trigger?.kind !== 'schedule') continue
    try {
      const next = computeNextRun(wf.trigger.schedule, wf.trigger.timezone ?? 'UTC', now)
      const at = next.getTime()
      if (Number.isNaN(at) || at <= now.getTime()) continue
      runs.push({ id: wf.id, name: wf.name, nextRunAt: next.toISOString(), at })
    } catch {
      // Unsupported cron / malformed schedule → no upcoming run for this one.
    }
  }
  return runs
    .sort((a, b) => a.at - b.at)
    .slice(0, UPCOMING_CAP)
    .map(({ id, name, nextRunAt }) => ({ id, name, nextRunAt }))
}

async function countPendingApprovals(workspaceId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM pending_approvals
     WHERE workspace_id = $1 AND status = 'pending'`,
    [workspaceId],
  )
  return Number.parseInt(res.rows[0]?.count ?? '0', 10)
}

/** Confirmed autopilot goals needing the user (task-goal-autopilot.md §8):
 *  blocked (clarity question / metering / budget), or armed but not yet
 *  working (no workflow started — ready to kick start). Drafts count under
 *  `countTaskTriage`; a confirmed goal sitting in `awaiting_approval` is
 *  already counted by `countPendingApprovals` — one item, one card. */
async function countAutopilotAttention(workspaceId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM goals
     WHERE workspace_id = $1
       AND status NOT IN ('done', 'abandoned')
       AND confirmed_at IS NOT NULL
       AND (status = 'blocked'
            OR (status = 'active' AND (means ->> 'workflowId') IS NULL))`,
    [workspaceId],
  )
  return Number.parseInt(res.rows[0]?.count ?? '0', 10)
}

/** Tasks assignable (§8): judge-drafted goals awaiting the user's triage —
 *  unconfirmed, non-terminal. Backs the `task_triage` card. */
async function countTaskTriage(workspaceId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM goals
     WHERE workspace_id = $1
       AND status NOT IN ('done', 'abandoned')
       AND confirmed_at IS NULL`,
    [workspaceId],
  )
  return Number.parseInt(res.rows[0]?.count ?? '0', 10)
}

/** Stale task backlog for the `task_cleanup` card — open tasks
 *  (todo/in_progress/blocked, live version only) untouched for 30+ days.
 *  The window mirrors `STALE_AFTER_DAYS` in app-web's `tasks-view.ts` (the
 *  surface's "Stale" preset) so the card's count and the deep-linked
 *  `/tasks?filter=stale` list always agree (tasks-operator-surface §4). */
async function countTaskCleanup(workspaceId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tasks
     WHERE workspace_id = $1
       AND valid_to IS NULL
       AND status IN ('todo', 'in_progress', 'blocked')
       AND updated_at < now() - interval '30 days'`,
    [workspaceId],
  )
  return Number.parseInt(res.rows[0]?.count ?? '0', 10)
}

/** Overdue pipeline for the `deal_attention` card — live deal entities whose
 *  close_date has passed while the stage is still open (not won/lost; a
 *  missing stage defaults to 'lead' — the same COALESCE the crm.ts read
 *  path applies). Mirrors `matchesDealQuickFilter('overdue')` in app-web's
 *  `crm-view.ts` (the surface's "Overdue close" preset) so the card's count
 *  and the deep-linked `/crm?filter=overdue` list always agree
 *  (crm-operator-surface §6). */
async function countDealAttention(workspaceId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM entities
     WHERE workspace_id = $1
       AND kind = 'deal'
       AND valid_to IS NULL
       AND retracted_at IS NULL
       AND COALESCE(attributes->>'stage', 'lead') NOT IN ('won', 'lost')
       AND (attributes->>'close_date') IS NOT NULL
       AND (attributes->>'close_date')::date < CURRENT_DATE`,
    [workspaceId],
  )
  return Number.parseInt(res.rows[0]?.count ?? '0', 10)
}

/** Workspace connectors whose credentials stopped working at call time
 *  (`health_status = 'auth_failed'`, migration 294) — ingestion and tools are
 *  dead until the user reconnects. Deliberately scoped to `connected = true`:
 *  a connector the user turned off is intent, not breakage. */
async function countConnectorAttention(workspaceId: string): Promise<number> {
  // Closed/overlay table — absent in the OSS edition (same guard as
  // `workspaceHasConnector` below).
  if (isOssEdition()) return 0
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM connector_instance
     WHERE workspace_id = $1 AND scope = 'workspace'
       AND connected = true AND health_status = 'auth_failed'`,
    [workspaceId],
  )
  return Number.parseInt(res.rows[0]?.count ?? '0', 10)
}

/** Workflow runs that ended `failed`/`timeout` recently. `awaiting_input` runs
 *  are excluded — each carries a pending approval already counted by
 *  `countPendingApprovals` (one item, one card). */
async function countWorkflowAttention(workspaceId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM workflow_runs
     WHERE workspace_id = $1
       AND status IN ('failed', 'timeout')
       AND COALESCE(finished_at, last_active_at) >= NOW() - INTERVAL '${RUN_ATTENTION_WINDOW}'`,
    [workspaceId],
  )
  return Number.parseInt(res.rows[0]?.count ?? '0', 10)
}

/** Brain entries = current entities + current (non-retracted) memories. */
async function countBrainEntries(workspaceId: string): Promise<{ total: number; last7: number }> {
  const res = await query<{ total: string; last7: string }>(
    `SELECT
       (SELECT COUNT(*) FROM entities WHERE workspace_id = $1 AND valid_to IS NULL)
       + (SELECT COUNT(*) FROM memories WHERE workspace_id = $1 AND valid_to IS NULL AND retracted_at IS NULL) AS total,
       (SELECT COUNT(*) FROM entities WHERE workspace_id = $1 AND valid_to IS NULL AND created_at >= NOW() - INTERVAL '7 days')
       + (SELECT COUNT(*) FROM memories WHERE workspace_id = $1 AND valid_to IS NULL AND retracted_at IS NULL AND created_at >= NOW() - INTERVAL '7 days') AS last7`,
    [workspaceId],
  )
  const row = res.rows[0]
  return {
    total: Number.parseInt(row?.total ?? '0', 10),
    last7: Number.parseInt(row?.last7 ?? '0', 10),
  }
}

/** Daily new-entry counts (entities + memories) for the last SPARKLINE_DAYS
 *  UTC days, oldest first — the brain card draws the real growth curve from
 *  this instead of a decorative one. Days with no rows fill as 0. */
async function brainSparkline(workspaceId: string, now: Date): Promise<number[]> {
  const res = await query<{ day: string; count: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, COUNT(*)::text AS count FROM (
       SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day FROM entities
        WHERE workspace_id = $1 AND valid_to IS NULL
          AND created_at >= NOW() - INTERVAL '${SPARKLINE_DAYS} days'
       UNION ALL
       SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') FROM memories
        WHERE workspace_id = $1 AND valid_to IS NULL AND retracted_at IS NULL
          AND created_at >= NOW() - INTERVAL '${SPARKLINE_DAYS} days'
     ) t GROUP BY 1 ORDER BY 1`,
    [workspaceId],
  )
  const byDay = new Map(res.rows.map((r) => [r.day, Number.parseInt(r.count, 10)]))
  const days: number[] = []
  for (let i = SPARKLINE_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000)
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    days.push(byDay.get(key) ?? 0)
  }
  return days
}

async function workspaceHasConnector(workspaceId: string): Promise<boolean> {
  // `connector_instance` is a closed/overlay table that does not exist in the
  // OSS edition (no connector surface ships there), so skip the probe instead
  // of letting every home-dock assembly throw + log a benign "relation does not
  // exist". Returns false → onboarding shows "no connector", which is correct.
  if (isOssEdition()) return false
  const res = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM connector_instance
     WHERE workspace_id = $1 AND scope = 'workspace' AND connected = true LIMIT 1`,
    [workspaceId],
  )
  return res.rows.length > 0
}
