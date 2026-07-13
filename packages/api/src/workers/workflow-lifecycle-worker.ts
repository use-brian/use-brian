/**
 * Workflow lifecycle sweep worker.
 *
 * Walks every workflow through the retirement ladder (mig 308):
 * `active → stale → archived → deleted` (one-offs only), with the policy
 * itself living in @sidanclaw/core (`decideLifecycle` — pure, table-tested)
 * and this worker owning orchestration: apply transitions, emit audit
 * events, and run the per-workspace DIGEST pass that offers retiring
 * workflows to the skill system as `staged_skill_creation` candidates.
 *
 * Factory-shaped like `views-prune-worker` (tick/start/stop, re-entrancy
 * guard, never throws past the catch) with the `skill-review-worker`'s
 * enablement double-gate: constructed with `enabled` from
 * `WORKFLOW_LIFECYCLE_ENABLED` (default false — ships dark) and started
 * only where `runWorkers` is true (the `sidanclaw-api-workers` service).
 *
 * Spec: docs/architecture/features/workflow-lifecycle.md.
 * Component tag: [COMP:workers/workflow-lifecycle-worker]
 */

import {
  decideLifecycle,
  pickDigestBatch,
  lastActivityAt,
  WORKFLOW_LIFECYCLE_DEFAULTS,
  type WorkflowDigestVerdict,
  type WorkflowLifecycleConfig,
  type WorkflowLifecycleRow,
  type WorkflowLifecycleState,
  type WorkflowRecord,
  type WorkflowStep,
} from '@sidanclaw/core'
import type { DigestWorkflowSummary, WorkflowDigestLLM } from './workflow-digest-llm.js'

/** Tick cadence: twice a day. Staleness is day-granular; this is plenty. */
export const DEFAULT_TICK_INTERVAL_MS = 12 * 60 * 60 * 1000

/** Per-workspace digest batch ceiling per tick. */
export const DEFAULT_DIGEST_BATCH_LIMIT = 40

/** A sweep row (core policy shape) plus the attribution column. */
export type LifecycleSweepRecord = WorkflowLifecycleRow & { createdBy: string }

/** The system-level store surface (workflow-store.ts sweep functions). */
export type WorkflowLifecycleSweepStore = {
  listSweepRows(): Promise<LifecycleSweepRecord[]>
  applyTransition(
    workflowId: string,
    state: WorkflowLifecycleState,
    reason: string | null,
  ): Promise<void>
  markDigested(workflowIds: string[], verdicts: Map<string, WorkflowDigestVerdict>): Promise<void>
  deleteWorkflow(workflowId: string): Promise<boolean>
  /** Full record read (definition needed for digest summaries + delete snapshot). */
  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>
}

/** The skill-system surface the digest pass writes through. */
export type WorkflowLifecycleSkillPort = {
  /** RLS-scoped listing — `actingUserId` is a workspace member (the batch's attribution user). */
  listSkillSummaries(
    workspaceId: string,
    actingUserId: string,
  ): Promise<Array<{ slug: string; name: string; description: string }>>
  /** True when the slug is taken — a live workspace skill OR an unresolved staged creation. */
  hasPendingOrExistingSlug(workspaceId: string, slug: string): Promise<boolean>
  stageCandidate(params: {
    workspaceId: string
    umbrella: { slug: string; name: string; description: string; content: string }
    approverUserId: string
    sourceWorkflowIds: string[]
  }): Promise<void>
}

export type WorkflowLifecycleAuditEvent = {
  workspaceId: string
  eventType:
    | 'workflow.lifecycle_staled'
    | 'workflow.lifecycle_archived'
    | 'workflow.lifecycle_reactivated'
    | 'workflow.lifecycle_deleted'
    | 'workflow.digested'
  subjectId: string
  details: Record<string, unknown>
}

/** Test/observability hook events (mirrors the skill-review worker). */
export type WorkflowLifecycleEvent =
  | { type: 'tick_start'; workflowCount: number }
  | { type: 'transition'; workflowId: string; action: string; reason: string }
  | { type: 'transition_failed'; workflowId: string; reason: string }
  | { type: 'digest_start'; workspaceId: string; batchSize: number }
  | { type: 'digest_complete'; workspaceId: string; candidates: number; staged: number }
  | { type: 'digest_failed'; workspaceId: string; reason: string }
  | {
      type: 'tick_complete'
      staled: number
      archived: number
      reactivated: number
      deleted: number
      digested: number
      staged: number
    }

export type WorkflowLifecycleWorkerOptions = {
  store: WorkflowLifecycleSweepStore
  /** Absent → sweep-only (no digestion). */
  digestLLM?: WorkflowDigestLLM
  /** Absent → digestion is skipped even when the LLM is wired. */
  skillPort?: WorkflowLifecycleSkillPort
  emitAudit?: (event: WorkflowLifecycleAuditEvent) => Promise<void> | void
  config?: Partial<WorkflowLifecycleConfig>
  digestBatchLimit?: number
  /** `WORKFLOW_LIFECYCLE_ENABLED` — default false, the feature ships dark. */
  enabled?: boolean
  tickIntervalMs?: number
  /** If true, runs an immediate tick on `start()`. Production: yes; tests: false. */
  runImmediately?: boolean
  /** Override `now` for tests. */
  now?: () => Date
  onEvent?: (event: WorkflowLifecycleEvent) => void
  /** Test-only error hook. Defaults to `console.error`. */
  onError?: (err: unknown) => void
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function summarizeStep(step: WorkflowStep): { type: string; summary: string } {
  switch (step.type) {
    case 'assistant_call':
      return { type: step.type, summary: truncate(step.prompt, 300) }
    case 'tool_call':
      return { type: step.type, summary: step.toolName }
    case 'wait':
      return { type: step.type, summary: 'wait for a datetime / duration' }
    case 'branch':
      return { type: step.type, summary: 'conditional branch' }
    case 'send_page':
      return { type: step.type, summary: 'send a page verbatim via email' }
  }
}

/** The creator cited most often across the candidate's source workflows. */
function mostCommonCreator(rows: LifecycleSweepRecord[]): string | null {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.createdBy, (counts.get(row.createdBy) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [userId, count] of counts) {
    if (count > bestCount) {
      best = userId
      bestCount = count
    }
  }
  return best
}

export function createWorkflowLifecycleWorker(options: WorkflowLifecycleWorkerOptions) {
  const store = options.store
  const config: WorkflowLifecycleConfig = { ...WORKFLOW_LIFECYCLE_DEFAULTS, ...options.config }
  const digestBatchLimit = options.digestBatchLimit ?? DEFAULT_DIGEST_BATCH_LIMIT
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const enabled = options.enabled ?? false
  const runImmediately = options.runImmediately ?? true
  const now = options.now ?? (() => new Date())
  const onEvent = options.onEvent
  const onError =
    options.onError ?? ((err) => console.error('[workflow-lifecycle] tick failed:', err))

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function emitAudit(event: WorkflowLifecycleAuditEvent): Promise<void> {
    try {
      await options.emitAudit?.(event)
    } catch (err) {
      // Audit is observability, never control flow.
      console.warn('[workflow-lifecycle] audit emit failed:', err)
    }
  }

  async function applyTransitions(rows: LifecycleSweepRecord[], at: Date) {
    const counters = { staled: 0, archived: 0, reactivated: 0, deleted: 0 }
    // Post-transition view of the world, digest pool input. Deleted rows drop.
    const alive: LifecycleSweepRecord[] = []

    for (const row of rows) {
      const decision = decideLifecycle(row, at, config)
      if (decision.action === 'none') {
        alive.push(row)
        continue
      }
      try {
        switch (decision.action) {
          case 'reactivate': {
            await store.applyTransition(row.id, 'active', null)
            counters.reactivated += 1
            await emitAudit({
              workspaceId: row.workspaceId,
              eventType: 'workflow.lifecycle_reactivated',
              subjectId: row.id,
              details: { workflowId: row.id, name: row.name, reason: decision.reason },
            })
            alive.push({
              ...row,
              lifecycleState: 'active',
              lifecycleTransitionedAt: at,
            })
            break
          }
          case 'mark_stale': {
            await store.applyTransition(row.id, 'stale', decision.reason)
            counters.staled += 1
            await emitAudit({
              workspaceId: row.workspaceId,
              eventType: 'workflow.lifecycle_staled',
              subjectId: row.id,
              details: { workflowId: row.id, name: row.name, reason: decision.reason },
            })
            alive.push({
              ...row,
              lifecycleState: 'stale',
              lifecycleTransitionedAt: at,
            })
            break
          }
          case 'archive': {
            await store.applyTransition(row.id, 'archived', decision.reason)
            counters.archived += 1
            await emitAudit({
              workspaceId: row.workspaceId,
              eventType: 'workflow.lifecycle_archived',
              subjectId: row.id,
              details: { workflowId: row.id, name: row.name, reason: decision.reason },
            })
            alive.push({
              ...row,
              lifecycleState: 'archived',
              lifecycleTransitionedAt: at,
              enabled: false,
            })
            break
          }
          case 'delete': {
            // Hold an undigested row until the digest pass has seen it —
            // deletion must never outrun value preservation.
            if (options.digestLLM && options.skillPort && row.digestedAt === null) {
              alive.push(row)
              break
            }
            // Snapshot BEFORE the row is gone; the audit event is the only
            // durable trace of a deleted workflow.
            const record = await store.getWorkflow(row.id)
            await store.deleteWorkflow(row.id)
            counters.deleted += 1
            await emitAudit({
              workspaceId: row.workspaceId,
              eventType: 'workflow.lifecycle_deleted',
              subjectId: row.id,
              details: {
                workflowId: row.id,
                name: row.name,
                description: row.description,
                triggerKind: row.trigger.kind,
                stepCount: record?.definition.steps.length ?? null,
                runCount: row.runCount,
                reason: decision.reason,
              },
            })
            break
          }
        }
        onEvent?.({ type: 'transition', workflowId: row.id, action: decision.action, reason: decision.reason })
      } catch (err) {
        // One row's failure never aborts the sweep.
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workflow-lifecycle] transition failed for ${row.id}:`, err)
        onEvent?.({ type: 'transition_failed', workflowId: row.id, reason: message })
        alive.push(row)
      }
    }

    return { counters, alive }
  }

  async function digestWorkspace(
    workspaceId: string,
    batch: LifecycleSweepRecord[],
    at: Date,
  ): Promise<{ digested: number; staged: number }> {
    const digestLLM = options.digestLLM
    const skillPort = options.skillPort
    if (!digestLLM || !skillPort) return { digested: 0, staged: 0 }

    onEvent?.({ type: 'digest_start', workspaceId, batchSize: batch.length })

    // Summarize each workflow; a failed definition read drops the row from
    // this batch (it stays undigested and returns on a later tick).
    const summarized: Array<{ row: LifecycleSweepRecord; summary: DigestWorkflowSummary }> = []
    for (const row of batch) {
      try {
        const record = await store.getWorkflow(row.id)
        if (!record) continue
        summarized.push({
          row,
          summary: {
            id: row.id,
            name: row.name,
            description: row.description,
            triggerKind: row.trigger.kind,
            runCount: row.runCount,
            idleDays: Math.max(
              0,
              Math.floor((at.getTime() - lastActivityAt(row).getTime()) / (24 * 60 * 60 * 1000)),
            ),
            steps: record.definition.steps.map(summarizeStep),
          },
        })
      } catch (err) {
        console.warn(`[workflow-lifecycle] definition read failed for ${row.id}:`, err)
      }
    }
    if (summarized.length === 0) return { digested: 0, staged: 0 }

    const batchRows = summarized.map((s) => s.row)
    const attributionUser = mostCommonCreator(batchRows)
    if (!attributionUser) return { digested: 0, staged: 0 }

    let existingSkills: Array<{ slug: string; name: string; description: string }> = []
    try {
      existingSkills = await skillPort.listSkillSummaries(workspaceId, attributionUser)
    } catch (err) {
      console.warn(`[workflow-lifecycle] skill listing failed for ${workspaceId}:`, err)
    }

    // The LLM call is the fallible core: a throw leaves the whole batch
    // undigested for the next tick (idempotence anchor untouched).
    const plan = await digestLLM.plan({
      workspaceId,
      workflows: summarized.map((s) => s.summary),
      existingSkills,
      userId: attributionUser,
    })

    const batchIds = new Set(batchRows.map((r) => r.id))
    const byId = new Map(batchRows.map((r) => [r.id, r]))
    const verdicts = new Map<string, WorkflowDigestVerdict>()
    let staged = 0

    for (const candidate of plan.candidates) {
      // Only ids from this batch count as provenance; hallucinated ids drop.
      const cited = candidate.sourceWorkflowIds.filter((id) => batchIds.has(id))
      if (cited.length === 0) continue
      try {
        if (await skillPort.hasPendingOrExistingSlug(workspaceId, candidate.slug)) continue
        const citedRows = cited.map((id) => byId.get(id) as LifecycleSweepRecord)
        await skillPort.stageCandidate({
          workspaceId,
          umbrella: {
            slug: candidate.slug,
            name: candidate.name,
            description: candidate.description,
            content: candidate.content,
          },
          approverUserId: mostCommonCreator(citedRows) ?? attributionUser,
          sourceWorkflowIds: cited,
        })
        staged += 1
        for (const id of cited) verdicts.set(id, 'skill_candidate')
        await emitAudit({
          workspaceId,
          eventType: 'workflow.digested',
          subjectId: cited[0],
          details: { workspaceId, slug: candidate.slug, sourceWorkflowIds: cited },
        })
      } catch (err) {
        // A failed candidate never blocks the rest of the plan.
        console.warn(
          `[workflow-lifecycle] staging candidate '${candidate.slug}' failed for ${workspaceId}:`,
          err,
        )
      }
    }

    await store.markDigested([...batchIds], verdicts)
    onEvent?.({
      type: 'digest_complete',
      workspaceId,
      candidates: plan.candidates.length,
      staged,
    })
    return { digested: batchIds.size, staged }
  }

  async function tickInner(): Promise<void> {
    const at = now()
    const rows = await store.listSweepRows()
    onEvent?.({ type: 'tick_start', workflowCount: rows.length })

    const { counters, alive } = await applyTransitions(rows, at)

    let digested = 0
    let staged = 0
    if (options.digestLLM && options.skillPort) {
      const byWorkspace = new Map<string, LifecycleSweepRecord[]>()
      for (const row of alive) {
        const group = byWorkspace.get(row.workspaceId)
        if (group) group.push(row)
        else byWorkspace.set(row.workspaceId, [row])
      }
      for (const [workspaceId, group] of byWorkspace) {
        const batch = pickDigestBatch(group, digestBatchLimit)
        if (batch.length === 0) continue
        try {
          const outcome = await digestWorkspace(workspaceId, batch, at)
          digested += outcome.digested
          staged += outcome.staged
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[workflow-lifecycle] digest failed for workspace ${workspaceId}:`, err)
          onEvent?.({ type: 'digest_failed', workspaceId, reason: message })
        }
      }
    }

    onEvent?.({ type: 'tick_complete', ...counters, digested, staged })
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      await tickInner()
    } catch (err) {
      // A single tick failure must not crash the host process.
      onError(err)
    } finally {
      running = false
    }
  }

  return {
    /** Run one tick immediately. Exposed for tests and operator triggers. */
    tick,
    start() {
      if (!enabled) {
        console.log(
          '[workflow-lifecycle] worker disabled (set WORKFLOW_LIFECYCLE_ENABLED=true to enable)',
        )
        return
      }
      if (timer) return
      console.log(
        `[workflow-lifecycle] worker started (interval: ${tickIntervalMs}ms, stale: ${config.staleAfterDays}d, archive: ${config.archiveAfterDays}d, delete: ${config.deleteAfterDays}d)`,
      )
      timer = setInterval(() => {
        void tick()
      }, tickIntervalMs)
      if (runImmediately) void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[workflow-lifecycle] worker stopped')
      }
    },
    get isRunning() {
      return timer !== undefined
    },
  }
}
