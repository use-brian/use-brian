/**
 * Sprint-variance commitment resolver — the per-kind domain resolver
 * for `commitment:sprint_variance` memories.
 *
 * Background: a `commitment:sprint_variance` memory is written when a
 * task slips its planned `due` date (the daily sprint-check turn, via
 * `saveMemory` with the locked commitment-memory tag convention). The
 * memory carries a `task:<uuid>` tag identifying the slipped task.
 * This resolver checks the task's *current* (post-supersession) state
 * and resolves the commitment when the slip has cleared:
 *
 *  - task closed (`status: done`)          → resolved ("task completed")
 *  - task archived                         → resolved ("task archived")
 *  - task replanned (`due` now in future
 *    or null)                              → resolved ("replanned")
 *  - task missing (deleted / retracted)    → resolved ("no longer exists")
 *  - otherwise (still slipping)            → still open
 *
 * The lookup is **system-level** (no AccessContext) — the
 * commitment-lifecycle worker drains commitments across all workspaces
 * and has no per-user session. The lookup interface stays a thin port
 * so this module is DB-free and the resolver is unit-testable with a
 * fake. The concrete impl is `getTaskByIdSystem` in
 * `packages/api/src/db/tasks.ts`.
 *
 * Specs:
 *  - decisions-log.md 2026-05-14 → "SV — Sprint tracking via tasks primitive"
 *  - decisions-log.md 2026-05-14 → "SV — Commitment-memory convention"
 *  - corrections.md → "Commitment-memory lifecycle" (sprint_variance row)
 *
 * [COMP:brain/sprint-variance-resolver]
 */

import type { TaskRecordStatus } from '../tasks/types.js'
import type { CommitmentResolution, CommitmentResolver } from './commitment-lifecycle-worker.js'
import type { MemoryRecord } from './types.js'

/** Tag prefix that ties a commitment memory to the task it refers to. */
export const TASK_TAG_PREFIX = 'task:'

/** Subset of a task the sprint-variance resolver inspects. Status tracks the
 *  canonical `TaskRecordStatus` so a new status (e.g. `in_review`) never drifts. */
export type SprintTaskSnapshot = {
  status: TaskRecordStatus
  due: Date | null
}

/**
 * System-level task lookup port. Returns the *active* task row (i.e.
 * the post-supersession current version) by id, or null if not found.
 * Implemented against `getTaskByIdSystem`; kept as a port so the
 * resolver tests can swap in a fake.
 */
export type SprintTaskLookup = (taskId: string) => Promise<SprintTaskSnapshot | null>

/**
 * Read the `task:<uuid>` tag from a commitment memory. Returns the id
 * or null if no `task:` tag is present or its suffix is empty.
 */
export function taskIdFromCommitment(memory: MemoryRecord): string | null {
  for (const tag of memory.tags) {
    if (!tag.startsWith(TASK_TAG_PREFIX)) continue
    const id = tag.slice(TASK_TAG_PREFIX.length)
    if (id.length > 0) return id
  }
  return null
}

export type SprintVarianceResolverOptions = {
  lookup: SprintTaskLookup
  /** Clock seam for tests. Defaults to `() => new Date()`. */
  now?: () => Date
}

export function createSprintVarianceResolver(
  options: SprintVarianceResolverOptions,
): CommitmentResolver {
  const { lookup } = options
  const now = options.now ?? (() => new Date())

  return async (memory: MemoryRecord): Promise<CommitmentResolution> => {
    const taskId = taskIdFromCommitment(memory)
    if (taskId === null) {
      // No task reference — the resolver can't decide. Stay open and
      // let the deadline backstop (or a manual supersession) close it.
      return { resolved: false }
    }

    const task = await lookup(taskId)
    if (task === null) {
      // Task is no longer reachable (deleted / fully retracted).
      // Treat as cleared so the worker doesn't surface the row forever.
      return { resolved: true, reason: `task ${taskId} no longer exists` }
    }
    if (task.status === 'done') {
      return { resolved: true, reason: `task ${taskId} completed` }
    }
    if (task.status === 'archived') {
      return { resolved: true, reason: `task ${taskId} archived` }
    }
    if (task.due === null || task.due.getTime() > now().getTime()) {
      return {
        resolved: true,
        reason: `task ${taskId} replanned (due ${
          task.due ? task.due.toISOString() : 'cleared'
        })`,
      }
    }
    // Task still slipping — past due AND not done/archived/replanned.
    return { resolved: false }
  }
}
