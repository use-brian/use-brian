/**
 * Skill review worker — V2 (WS-B).
 *
 * Per active session every N turns (default 10), forks a background-review
 * agent that:
 *
 *   1. Acquires a review lease on each candidate skill (S10 — first-writer-
 *      wins, 5 min default). UPDATE returning 0 rows → skip this skill,
 *      log `skill_review_skipped_concurrent`.
 *   2. Reads conversation history + currently-loaded skills.
 *   3. Calls Flash with the update-first preference rules. The LLM returns
 *      a plan of `skill_manage` actions, which the worker applies one at a
 *      time through the tool's routing + validation.
 *   4. Applies each action independently (per-action isolation): a failed
 *      action is logged and skipped, the cycle continues. There is no
 *      cross-action DB transaction — each `applyPatch` is its own atomic
 *      UPDATE, and the per-workspace daily cap bounds blast radius. (True
 *      cycle-level atomicity + bi-temporal supersession on patch is a
 *      documented V2.1 hardening — see the spec.)
 *   5. Releases held leases regardless of outcome.
 *
 * Failure modes per spec (`docs/architecture/engine/skill-system.md` →
 * "Failure modes"):
 *
 *   * Plan-shape validation error → the LLM port (`skill-review-llm.ts`)
 *     re-prompts ONCE with the rejection reason; a still-invalid plan
 *     degrades to an empty (no-op) cycle.
 *   * Apply-time `skill_manage` error → log `skill_review_action_failed` +
 *     skip that action; cycle continues.
 *   * LLM plan call throws → log `skill_review_cycle_failed`; the session is
 *     left for the next tick.
 *
 * Per-workspace rate cap (`docs/architecture/engine/skill-system.md` →
 * "Per-workspace rate cap"): 10 auto-gen skill ops per workspace per day,
 * counted from today's `skill_review_action_succeeded` analytics events.
 * Over cap → skip cycle + log `skill_review_rate_capped`.
 *
 * Tick cadence mirrors the consolidation worker (15 min default). Gated
 * on `SKILLS_AUTO_GEN_ENABLED=true` at boot — the worker still
 * constructs but `start()` only schedules the timer when the flag is
 * set. Single-instance assumption; no advisory lock.
 *
 * [COMP:workers/skill-review-worker]
 */

import { query } from '../db/client.js'
import { sanitize, type AnalyticsStore } from '@sidanclaw/core'
import type { WorkspaceSkillStore } from '../db/skill-store.js'
import type {
  WorkspaceSkillFilesStore,
  SkillFileKind,
} from '../db/workspace-skill-files-store.js'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'

// ── Tunables ──────────────────────────────────────────────────────

/** Default tick cadence: 15 min — same shape as the consolidation worker. */
const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1000

/** Default first-tick delay so boot stays fast. */
const DEFAULT_FIRST_TICK_DELAY_MS = 30_000

/** Default per-session nudge interval — every N assistant turns. */
const DEFAULT_NUDGE_INTERVAL = 10

/** Default lease duration on a skill row during review. */
const DEFAULT_LEASE_MINUTES = 5

/**
 * Per-workspace daily cap — 10 auto-generated skill ops per workspace per
 * day. Spec: "Per-workspace rate cap" — backstop above the per-session
 * 10-turn cadence so concurrent sessions can't fan out into runaway
 * writes.
 */
const DEFAULT_DAILY_OP_CAP_PER_WORKSPACE = 10

/**
 * Convert "active session" to "session that has been written to in the
 * last 24 hours". Anything older is treated as cold — nothing to learn
 * from. Matches the consolidation worker's `hasRecentActivity` shape.
 */
const ACTIVE_SESSION_LOOKBACK_HOURS = 24

// ── Worker handle ─────────────────────────────────────────────────

export type SkillReviewEvent =
  | { type: 'tick_start'; sessionCount: number }
  | {
      type: 'session_reviewed'
      sessionId: string
      workspaceId: string
      assistantId: string
      userId: string
      actionsTaken: number
      ratecapped: boolean
    }
  | { type: 'session_skipped'; sessionId: string; reason: string }
  | { type: 'lease_skipped'; skillId: string; sessionId: string }
  | { type: 'action_failed'; sessionId: string; reason: string; recoverable: boolean }
  | { type: 'cycle_failed'; sessionId: string; reason: string }
  | { type: 'tick_complete'; reviewed: number; skipped: number; failed: number }

export type SkillReviewWorkerHandle = {
  tick(): Promise<void>
  start(): void
  stop(): void
  readonly isRunning: boolean
}

// ── Review LLM port ───────────────────────────────────────────────

/**
 * The worker invokes the review LLM via this port. The implementation in
 * `apps/api` builds a Gemini Flash call with the conversation history +
 * currently-loaded skills + the update-first preference rules; tests pass
 * a fake that returns a deterministic action plan.
 *
 * The LLM emits a sequence of `skill_manage` actions; the worker passes
 * each through the `skill_manage` tool's validation + routing logic. The
 * tool's response is fed back to the LLM if a re-prompt is needed.
 *
 * Returning an empty action list is fine — the cycle is a no-op.
 */
export type SkillReviewLLM = {
  /**
   * Generate the action plan for one review cycle.
   *
   * `priorErrors` carries the rejection reasons from the previous
   * iteration so the LLM can correct. Empty on the first call.
   */
  plan(input: {
    sessionId: string
    workspaceId: string
    assistantId: string
    /** Session owner — used by the concrete LLM port for `overhead:skill-review`
     *  cost attribution (`usage_tracking.user_id` is NOT NULL). */
    userId: string
    transcriptExcerpt: string
    loadedSkills: Array<{ id: string; name: string; description: string; content: string }>
    priorErrors: string[]
  }): Promise<SkillReviewActionPlan>
}

export type SkillReviewAction =
  | {
      action: 'patch_skill' | 'update_umbrella'
      skillId: string
      patch: { newContent?: string; diff?: string }
    }
  | {
      action: 'add_support_file'
      skillId: string
      file: {
        kind: SkillFileKind
        name: string
        content: string
        description?: string
      }
    }
  | {
      action: 'create_umbrella'
      umbrella: {
        name: string
        description: string
        content: string
        supportFiles?: Array<{
          kind: SkillFileKind
          name: string
          content: string
          description?: string
        }>
      }
    }

export type SkillReviewActionPlan = {
  actions: SkillReviewAction[]
}

// ── Session candidate selection ───────────────────────────────────

type SessionCandidate = {
  sessionId: string
  workspaceId: string
  assistantId: string
  userId: string
  currentTurnCount: number
  lastReviewedTurn: number | null
}

/**
 * Find sessions that have crossed the nudge interval since their last
 * review. A "turn" is an assistant message; we count `session_messages`
 * rows with `role='assistant'`. The query is a single scan over recent
 * sessions and is bounded by the lookback window.
 *
 * Exported for unit tests — pass a fake `query` via the runtime if needed
 * (we read the module-level `query` here).
 */
export async function selectCandidateSessions(
  nudgeInterval: number,
  lookbackHours: number,
): Promise<SessionCandidate[]> {
  const result = await query<{
    session_id: string
    workspace_id: string
    assistant_id: string
    user_id: string
    current_turn_count: string
    last_skill_reviewed_turn: string | null
  }>(
    `WITH active AS (
       SELECT s.id, s.workspace_id, s.assistant_id, s.user_id,
              s.last_skill_reviewed_turn, s.last_active_at,
              (SELECT COUNT(*) FROM session_messages m
                WHERE m.session_id = s.id
                  AND m.role = 'assistant') AS turn_count
       FROM sessions s
       JOIN assistants a ON a.id = s.assistant_id
       WHERE s.last_active_at >= now() - ($1 || ' hours')::interval
         AND s.workspace_id IS NOT NULL
     )
     SELECT id           AS session_id,
            workspace_id,
            assistant_id,
            user_id,
            turn_count   AS current_turn_count,
            last_skill_reviewed_turn
     FROM active
     WHERE (last_skill_reviewed_turn IS NULL AND turn_count >= $2)
        OR (last_skill_reviewed_turn IS NOT NULL
            AND turn_count - last_skill_reviewed_turn >= $2)
     ORDER BY last_active_at ASC`,
    [lookbackHours, nudgeInterval],
  )
  return result.rows.map((r) => ({
    sessionId: r.session_id,
    workspaceId: r.workspace_id,
    assistantId: r.assistant_id,
    userId: r.user_id,
    currentTurnCount: parseInt(r.current_turn_count, 10),
    lastReviewedTurn: r.last_skill_reviewed_turn === null ? null : parseInt(r.last_skill_reviewed_turn, 10),
  }))
}

/** Fetch the most recent K turns as plain text — keeps the LLM prompt
 *  small. K defaults to 20. */
export async function fetchTranscriptExcerpt(
  sessionId: string,
  maxMessages: number,
): Promise<string> {
  const result = await query<{ role: string; content: unknown }>(
    `SELECT role, content
     FROM session_messages
     WHERE session_id = $1
     ORDER BY sequence_num DESC
     LIMIT $2`,
    [sessionId, maxMessages],
  )
  // Reverse to chronological order for the LLM prompt.
  const messages = result.rows.reverse()
  return messages
    .map((m) => {
      // Defensive: a malformed row (no role/content) yields an empty string
      // which the `.filter(Boolean)` drops. This protects against shape drift
      // from upstream query mocks or partial schema migrations.
      if (!m || typeof m.role !== 'string') return ''
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join(' ')
            : JSON.stringify(m.content)
      return `${m.role.toUpperCase()}: ${text}`
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 16_000) // Hard cap so we don't blow the LLM context.
}

/**
 * Mark the session as reviewed at the current turn count so the next tick
 * waits another N turns before re-reviewing.
 */
export async function markSessionReviewed(
  sessionId: string,
  turnCount: number,
): Promise<void> {
  await query(
    `UPDATE sessions
     SET last_skill_reviewed_turn = $1
     WHERE id = $2`,
    [turnCount, sessionId],
  )
}

// ── Per-workspace rate cap ────────────────────────────────────────

/**
 * Count today's auto-gen skill ops for a workspace from today's
 * `skill_review_action_succeeded` analytics events. (A future S10
 * `skill_curator_digest` signal could augment this, but it is not queried
 * today — successful curator actions are the sole counted signal.)
 *
 * Spec: `docs/architecture/engine/skill-system.md` → "Per-workspace
 * rate cap". Backstop above the per-session cadence.
 */
export async function countTodayOps(workspaceId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM analytics_events
     WHERE event_name = 'skill_review_action_succeeded'
       AND metadata->>'workspace_id' = $1
       AND created_at >= date_trunc('day', now())`,
    [workspaceId],
  )
  return parseInt(result.rows[0]?.count ?? '0', 10)
}

// ── Worker factory ────────────────────────────────────────────────

export type SkillReviewWorkerOptions = {
  /** Source of truth for skill rows + lease acquire/release. */
  workspaceSkillStore: WorkspaceSkillStore
  fileStore: WorkspaceSkillFilesStore
  approvalsStore: PendingApprovalsStore
  analyticsStore: AnalyticsStore
  reviewLLM: SkillReviewLLM
  /** Lease holder UUID for this worker instance — same value across cycles
   *  so the holder identity is stable in the DB. */
  leaseHolderId: string
  /** Per-session nudge interval. Default 10. Honors
   *  `SKILLS_CREATION_NUDGE_INTERVAL` env var when not overridden. */
  nudgeInterval?: number
  /** Lease duration in minutes. Default 5. */
  leaseMinutes?: number
  /** Per-workspace per-day op cap. Default 10. */
  dailyOpCapPerWorkspace?: number
  /** Tick interval. Default 15 min. */
  tickIntervalMs?: number
  /** First-tick delay. Default 30s. */
  firstTickDelayMs?: number
  /** Lookback for active sessions. Default 24h. */
  activeSessionLookbackHours?: number
  /** Whether the worker should run at all. False short-circuits start(). */
  enabled?: boolean
  /** Override `now` for tests. */
  now?: () => Date
  onEvent?: (event: SkillReviewEvent) => void
}

export function createSkillReviewWorker(
  options: SkillReviewWorkerOptions,
): SkillReviewWorkerHandle {
  const nudgeInterval = options.nudgeInterval ?? DEFAULT_NUDGE_INTERVAL
  const leaseMinutes = options.leaseMinutes ?? DEFAULT_LEASE_MINUTES
  const dailyOpCap = options.dailyOpCapPerWorkspace ?? DEFAULT_DAILY_OP_CAP_PER_WORKSPACE
  const tickInterval = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const firstTickDelay = options.firstTickDelayMs ?? DEFAULT_FIRST_TICK_DELAY_MS
  const lookbackHours = options.activeSessionLookbackHours ?? ACTIVE_SESSION_LOOKBACK_HOURS
  const enabled = options.enabled ?? false
  const now = options.now ?? (() => new Date())
  const onEvent = options.onEvent

  let intervalTimer: ReturnType<typeof setInterval> | undefined
  let initialTimer: ReturnType<typeof setTimeout> | undefined
  let running = false

  async function tickInner(): Promise<void> {
    const candidates = await selectCandidateSessions(nudgeInterval, lookbackHours)
    onEvent?.({ type: 'tick_start', sessionCount: candidates.length })

    let reviewed = 0
    let skipped = 0
    let failed = 0

    for (const candidate of candidates) {
      try {
        const outcome = await reviewSession(candidate, {
          workspaceSkillStore: options.workspaceSkillStore,
          fileStore: options.fileStore,
          approvalsStore: options.approvalsStore,
          analyticsStore: options.analyticsStore,
          reviewLLM: options.reviewLLM,
          leaseHolderId: options.leaseHolderId,
          leaseMinutes,
          dailyOpCap,
          onEvent,
          now,
        })
        if (outcome === 'reviewed') reviewed += 1
        else if (outcome === 'skipped') skipped += 1
        else failed += 1
      } catch (err) {
        failed += 1
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `[skill-review] uncaught error for session ${candidate.sessionId}:`,
          err,
        )
        onEvent?.({ type: 'cycle_failed', sessionId: candidate.sessionId, reason: message })
      }
    }

    onEvent?.({ type: 'tick_complete', reviewed, skipped, failed })
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      await tickInner()
    } catch (err) {
      console.error('[skill-review] tick failed:', err)
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      if (!enabled) {
        console.log('[skill-review] worker disabled (set SKILLS_AUTO_GEN_ENABLED=true to enable)')
        return
      }
      if (intervalTimer || initialTimer) return // idempotent
      console.log(
        `[skill-review] worker started (interval: ${tickInterval}ms, nudge: ${nudgeInterval}, lease: ${leaseMinutes}m, daily cap: ${dailyOpCap})`,
      )
      initialTimer = setTimeout(() => {
        initialTimer = undefined
        void tick().catch((err) =>
          console.error('[skill-review] initial tick failed:', err),
        )
      }, firstTickDelay)
      intervalTimer = setInterval(() => {
        void tick().catch((err) =>
          console.error('[skill-review] tick failed:', err),
        )
      }, tickInterval)
    },
    stop() {
      if (initialTimer) {
        clearTimeout(initialTimer)
        initialTimer = undefined
      }
      if (intervalTimer) {
        clearInterval(intervalTimer)
        intervalTimer = undefined
      }
    },
    get isRunning() {
      return intervalTimer !== undefined || initialTimer !== undefined
    },
  }
}

// ── Per-session review cycle (exported for tests) ────────────────

export type ReviewSessionDeps = {
  workspaceSkillStore: WorkspaceSkillStore
  fileStore: WorkspaceSkillFilesStore
  approvalsStore: PendingApprovalsStore
  analyticsStore: AnalyticsStore
  reviewLLM: SkillReviewLLM
  leaseHolderId: string
  leaseMinutes: number
  dailyOpCap: number
  onEvent?: (event: SkillReviewEvent) => void
  now: () => Date
}

export type ReviewOutcome = 'reviewed' | 'skipped' | 'failed'

/**
 * Run one review cycle for one session.
 *
 *   1. Rate-cap check — if at cap, log + skip.
 *   2. Fetch transcript + currently-loaded skills.
 *   3. Plan via the LLM (one shot; one re-prompt allowed on validation failure).
 *   4. Acquire review leases on every target skill that the plan touches.
 *      Skills whose lease can't be acquired are dropped from the plan.
 *   5. Validate + apply every action. Failures are isolated per action.
 *   6. Mark the session as reviewed at the current turn count.
 *   7. Release all leases.
 *
 * Returns the outcome so the worker can tally tick stats.
 */
export async function reviewSession(
  candidate: SessionCandidate,
  deps: ReviewSessionDeps,
): Promise<ReviewOutcome> {
  // ── Per-workspace rate cap ──
  const todayOps = await countTodayOps(candidate.workspaceId)
  if (todayOps >= deps.dailyOpCap) {
    deps.onEvent?.({
      type: 'session_skipped',
      sessionId: candidate.sessionId,
      reason: 'rate_capped',
    })
    await deps.analyticsStore.record({
      userId: candidate.userId,
      assistantId: candidate.assistantId,
      sessionId: candidate.sessionId,
      eventName: 'skill_review_rate_capped',
      metadata: {
        workspace_id: sanitize(candidate.workspaceId),
        today_ops: todayOps,
        daily_cap: deps.dailyOpCap,
      },
    })
    // Still mark the session as reviewed so we don't hammer it next tick.
    await markSessionReviewed(candidate.sessionId, candidate.currentTurnCount)
    return 'skipped'
  }

  // ── Fetch transcript + loaded skills ──
  const [transcriptExcerpt, workspaceSkills] = await Promise.all([
    fetchTranscriptExcerpt(candidate.sessionId, 30),
    deps.workspaceSkillStore.listForWorkspace(candidate.workspaceId),
  ])
  const loadedSkills = workspaceSkills
    .filter((s) => s.state !== 'archived')
    .map((s) => ({ id: s.rowId, name: s.name, description: s.description, content: s.content }))
  // Tenant-safety set: the model is shown only THIS workspace's skills, so a
  // target skillId that isn't among them is a hallucination (or, worse, a
  // valid UUID from another tenant). Drop those before any lease is touched so
  // the curator can never stamp a review lease on a foreign workspace's row
  // (`acquireReviewLease` keys on `id` alone). `create_umbrella` has no target.
  const knownSkillIds = new Set(loadedSkills.map((s) => s.id))

  // ── Plan via the LLM (with at most one corrective retry) ──
  let plan: SkillReviewActionPlan
  try {
    plan = await deps.reviewLLM.plan({
      sessionId: candidate.sessionId,
      workspaceId: candidate.workspaceId,
      assistantId: candidate.assistantId,
      userId: candidate.userId,
      transcriptExcerpt,
      loadedSkills,
      priorErrors: [],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.onEvent?.({ type: 'cycle_failed', sessionId: candidate.sessionId, reason: message })
    await deps.analyticsStore.record({
      userId: candidate.userId,
      assistantId: candidate.assistantId,
      sessionId: candidate.sessionId,
      eventName: 'skill_review_cycle_failed',
      metadata: { workspace_id: sanitize(candidate.workspaceId), reason: sanitize(message) },
    })
    return 'failed'
  }

  if (plan.actions.length === 0) {
    // No-op cycle — mark reviewed so we wait another N turns and move on.
    await markSessionReviewed(candidate.sessionId, candidate.currentTurnCount)
    deps.onEvent?.({
      type: 'session_reviewed',
      sessionId: candidate.sessionId,
      workspaceId: candidate.workspaceId,
      assistantId: candidate.assistantId,
      userId: candidate.userId,
      actionsTaken: 0,
      ratecapped: false,
    })
    return 'reviewed'
  }

  // ── Acquire leases on every target skill the plan touches ──
  // Foreign / hallucinated skillIds are filtered out here (tenant-safety),
  // so a non-create action targeting an unknown id is silently dropped (it
  // never gets a lease, so the executable-action filter below excludes it).
  const targetIds = collectTargetSkillIds(plan).filter((id) => knownSkillIds.has(id))
  const heldLeases: string[] = []
  for (const id of targetIds) {
    const acquired = await deps.workspaceSkillStore.acquireReviewLease(
      id,
      deps.leaseHolderId,
      deps.leaseMinutes,
    )
    if (acquired) {
      heldLeases.push(id)
    } else {
      deps.onEvent?.({ type: 'lease_skipped', skillId: id, sessionId: candidate.sessionId })
      await deps.analyticsStore.record({
        userId: candidate.userId,
        assistantId: candidate.assistantId,
        sessionId: candidate.sessionId,
        eventName: 'skill_review_skipped_concurrent',
        metadata: { workspace_id: sanitize(candidate.workspaceId), skill_id: sanitize(id) },
      })
    }
  }

  // Filter actions whose target couldn't be leased.
  const heldSet = new Set(heldLeases)
  const executableActions = plan.actions.filter((a) => {
    if (a.action === 'create_umbrella') return true // No existing target.
    return heldSet.has(a.skillId)
  })

  // ── Apply actions; collect outcome counts ──
  let succeeded = 0
  let actionFailures = 0
  let opsThisCycle = todayOps
  const remainingCap = deps.dailyOpCap

  try {
    for (const action of executableActions) {
      if (opsThisCycle >= remainingCap) {
        // Hit the cap mid-cycle — stop applying further actions and log.
        await deps.analyticsStore.record({
          userId: candidate.userId,
          assistantId: candidate.assistantId,
          sessionId: candidate.sessionId,
          eventName: 'skill_review_rate_capped',
          metadata: {
            workspace_id: sanitize(candidate.workspaceId),
            today_ops: opsThisCycle,
            daily_cap: remainingCap,
            phase: sanitize('mid_cycle'),
          },
        })
        break
      }

      try {
        await applyAction(action, {
          workspaceId: candidate.workspaceId,
          originatingAssistantId: candidate.assistantId,
          systemActorUserId: candidate.userId,
          leaseHolderId: deps.leaseHolderId,
          workspaceSkillStore: deps.workspaceSkillStore,
          fileStore: deps.fileStore,
          approvalsStore: deps.approvalsStore,
        })
        succeeded += 1
        opsThisCycle += 1
        await deps.analyticsStore.record({
          userId: candidate.userId,
          assistantId: candidate.assistantId,
          sessionId: candidate.sessionId,
          eventName: 'skill_review_action_succeeded',
          metadata: {
            workspace_id: sanitize(candidate.workspaceId),
            action: sanitize(action.action),
          },
        })
      } catch (err) {
        actionFailures += 1
        const message = err instanceof Error ? err.message : String(err)
        deps.onEvent?.({
          type: 'action_failed',
          sessionId: candidate.sessionId,
          reason: message,
          recoverable: true,
        })
        await deps.analyticsStore.record({
          userId: candidate.userId,
          assistantId: candidate.assistantId,
          sessionId: candidate.sessionId,
          eventName: 'skill_review_action_failed',
          metadata: {
            workspace_id: sanitize(candidate.workspaceId),
            action: sanitize(action.action),
            reason: sanitize(message),
          },
        })
      }
    }

    await markSessionReviewed(candidate.sessionId, candidate.currentTurnCount)
    deps.onEvent?.({
      type: 'session_reviewed',
      sessionId: candidate.sessionId,
      workspaceId: candidate.workspaceId,
      assistantId: candidate.assistantId,
      userId: candidate.userId,
      actionsTaken: succeeded,
      ratecapped: opsThisCycle >= remainingCap,
    })
    return actionFailures > 0 && succeeded === 0 ? 'failed' : 'reviewed'
  } finally {
    // Always release leases.
    for (const id of heldLeases) {
      try {
        await deps.workspaceSkillStore.releaseReviewLease(id, deps.leaseHolderId)
      } catch (err) {
        console.error(`[skill-review] lease release failed for ${id}:`, err)
      }
    }
  }
}

// ── Action dispatch ───────────────────────────────────────────────

type ApplyActionDeps = {
  workspaceId: string
  originatingAssistantId: string
  systemActorUserId: string
  leaseHolderId: string
  workspaceSkillStore: WorkspaceSkillStore
  fileStore: WorkspaceSkillFilesStore
  approvalsStore: PendingApprovalsStore
}

async function applyAction(action: SkillReviewAction, deps: ApplyActionDeps): Promise<void> {
  // The worker reuses the `skill_manage` tool's routing logic by calling
  // its internal action functions directly via store ports. The tool layer
  // is what the LLM sees; the worker is the *only* caller in production,
  // so we can bind the same ports here without going through the
  // ToolExecutor.
  //
  // We import the tool factory lazily inside the function so the worker
  // module doesn't pull in zod at boot before it's needed.
  const { createSkillManageTool } = await import('@sidanclaw/core')
  const tool = createSkillManageTool({
    workspaceId: deps.workspaceId,
    originatingAssistantId: deps.originatingAssistantId,
    leaseHolderId: deps.leaseHolderId,
    systemActorUserId: deps.systemActorUserId,
    workspaceSkillStore: skillStorePort(deps.workspaceSkillStore),
    fileStore: fileStorePort(deps.fileStore, deps.systemActorUserId),
    approvalsStore: approvalsPort(deps.approvalsStore, deps.systemActorUserId),
    enablementStore: enablementPortStub(),
  })

  // Inject context the tool's `execute` does not use beyond `input` —
  // the worker has already verified safety + lease + cap.
  const ctxStub = {
    userId: deps.systemActorUserId,
    assistantId: deps.originatingAssistantId,
    sessionId: 'background_review',
    appId: 'sidanclaw',
    channelType: 'system',
    channelId: 'background-review-worker',
    workspaceId: deps.workspaceId,
    abortSignal: new AbortController().signal,
  } as unknown as Parameters<typeof tool.execute>[1]
  const result = await tool.execute(action as unknown as never, ctxStub)
  if (result.isError) {
    const err = (result.data as { error?: string })?.error ?? 'unknown skill_manage error'
    throw new Error(err)
  }
}

// ── Store-port adapters ────────────────────────────────────────────
// The `skill_manage` tool was authored to a narrow port shape — the
// canonical WorkspaceSkillStore + WorkspaceSkillFilesStore + PendingApprovalsStore
// expose extra methods the tool doesn't need. These adapters narrow them
// to the tool's port shape and rebind any minor signature deltas.

function skillStorePort(ws: WorkspaceSkillStore) {
  return {
    async getSkillForWorkspace(workspaceId: string, rowId: string) {
      const row = await ws.getByIdSystem(rowId)
      if (!row || row.workspaceId !== workspaceId) return null
      return {
        rowId: row.rowId,
        workspaceId: row.workspaceId,
        slug: row.slug,
        name: row.name,
        source: row.source,
        writeOrigin: row.writeOrigin,
        pinned: row.pinned,
        state: row.state,
      }
    },
    async applyPatch(params: {
      rowId: string
      workspaceId: string
      newContent: string
      diff: string | null
      leaseHolderId: string
    }) {
      // The lease holder is enforced here — a stale-lease writer simply
      // updates 0 rows and the change is dropped, which surfaces upward as
      // a generic "no rows updated" failure. The worker treats it as a
      // skip on the offending action.
      const result = await query<{ id: string }>(
        `UPDATE workspace_skills
         SET content = $1,
             last_patch_diff = $2,
             last_patch_diff_at = now(),
             updated_at = now()
         WHERE id = $3
           AND workspace_id = $4
           AND review_lease_held_by = $5
           AND review_lease_until > now()
         RETURNING id`,
        [
          params.newContent,
          params.diff,
          params.rowId,
          params.workspaceId,
          params.leaseHolderId,
        ],
      )
      if ((result.rowCount ?? 0) === 0) {
        throw new Error(
          `applyPatch: no rows updated (skill ${params.rowId} — lease or row state changed during cycle)`,
        )
      }
    },
    async createAutoGenerated() {
      // Never called from the worker path — every create routes through
      // approvals. Kept on the port for future "trusted-curator" mode.
      throw new Error('createAutoGenerated: direct create not supported in V2')
    },
  }
}

function fileStorePort(fs: WorkspaceSkillFilesStore, actingUserId: string) {
  return {
    async list(workspaceSkillId: string) {
      const rows = await fs.list(workspaceSkillId)
      return rows.map((r) => ({ kind: r.kind, name: r.name, content: r.content }))
    },
    async upsert(params: {
      workspaceSkillId: string
      kind: SkillFileKind
      name: string
      content: string
      description?: string | null
      leaseHolderId: string
    }) {
      // The file store doesn't take a leaseHolder — the lease invariant is
      // enforced at the parent skill row's applyPatch path, so file inserts
      // under a leased skill are safe. We pass the session owner
      // (`systemActorUserId`, a real workspace member) as the acting userId:
      // the mig-169 `workspace_skill_files` RLS policy is USING-only with no
      // system_bypass escape, so an all-zeros UUID would fail the policy with
      // "new row violates row-level security policy". The owner satisfies the
      // workspace-member predicate.
      await fs.upsert(actingUserId, {
        workspaceSkillId: params.workspaceSkillId,
        kind: params.kind,
        name: params.name,
        content: params.content,
        description: params.description ?? null,
      })
    },
  }
}

function approvalsPort(approvals: PendingApprovalsStore, approverUserId: string) {
  return {
    async createStagedSkillUpdate(params: {
      workspaceId: string
      targetSkillId: string
      proposedPatch: {
        newContent?: string
        diff?: string
        addedFiles?: Array<{ kind: SkillFileKind; name: string; content: string; description?: string }>
      }
      originatingAssistantId: string | null
      requestedByUserId?: string | null
    }) {
      const row = await approvals.createStagedSkillUpdate({
        workspaceId: params.workspaceId,
        targetSkillId: params.targetSkillId,
        proposedPatch: params.proposedPatch,
        approverUserId: params.requestedByUserId ?? approverUserId,
        originatingAssistantId: params.originatingAssistantId,
      })
      return { approvalId: row.id }
    },
    async createStagedSkillCreation(params: {
      workspaceId: string
      proposedUmbrella: {
        slug: string
        name: string
        description: string
        content: string
        supportFiles?: Array<{ kind: SkillFileKind; name: string; content: string; description?: string }>
      }
      originatingAssistantId: string | null
    }) {
      const row = await approvals.createStagedSkillCreation({
        workspaceId: params.workspaceId,
        proposedUmbrella: params.proposedUmbrella,
        approverUserId,
        originatingAssistantId: params.originatingAssistantId,
      })
      return { approvalId: row.id }
    },
  }
}

function enablementPortStub() {
  // Enablement only fires on direct `create_umbrella` (which doesn't go
  // through the worker today — every create routes to approvals, and
  // approve-time enablement happens in the route handler).
  return {
    async enableForOriginating() {
      throw new Error('enableForOriginating: not called from worker path')
    },
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function collectTargetSkillIds(plan: SkillReviewActionPlan): string[] {
  const ids: string[] = []
  for (const action of plan.actions) {
    if (action.action !== 'create_umbrella') {
      ids.push(action.skillId)
    }
  }
  return Array.from(new Set(ids))
}
