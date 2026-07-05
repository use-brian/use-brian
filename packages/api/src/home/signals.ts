/**
 * Home signals assembler — the live source of truth for every NUMBER the
 * "Suggested for you" dock shows. Assembled per request from the brain inbox,
 * approvals, autopilot goals, workflows, drafts, and brain counts. The merge
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

import { computeNextRun, type HomeSignals, type WorkflowTrigger } from '@sidanclaw/core'
import type { SavedViewStore } from '@sidanclaw/core'
import { query } from '../db/client.js'
import { countBrainInbox } from '../db/brain-inbox-store.js'
import { isOssEdition } from '../routes/local-session.js'

const UPCOMING_CAP = 4
const DRAFTS_CAP = 4

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
  const [review, approvalsCount, autopilotCount, brain, workflows, drafts, hasConnector] = await Promise.all([
    safe(() => countBrainInbox(workspaceId).then((r) => r.total), 0),
    safe(() => countPendingApprovals(workspaceId), 0),
    safe(() => countAutopilotAttention(workspaceId), 0),
    safe(() => countBrainEntries(workspaceId), { total: 0, last7: 0 }),
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
    upcomingWorkflows: computeUpcoming(workflows, now),
    recentDrafts: drafts.map((d) => ({
      id: d.id,
      name: d.name,
      updatedAt: d.updatedAt.toISOString(),
    })),
    brainEntryCount: brain.total,
    brainGrowth7d: brain.last7,
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

/** Autopilot goals needing the user: unconfirmed drafts (may not act until
 *  confirmed) + blocked goals (clarity question / metering / budget). A
 *  confirmed goal sitting in `awaiting_approval` is already counted by
 *  `countPendingApprovals`, so it is excluded here — one item, one card. */
async function countAutopilotAttention(workspaceId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM goals
     WHERE workspace_id = $1
       AND status NOT IN ('done', 'abandoned')
       AND (confirmed_at IS NULL OR status = 'blocked')`,
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
