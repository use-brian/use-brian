/**
 * Brain candidate types — the queue + audit log for the self-healing
 * reclassifier (Q5/Q8 of the design thread).
 *
 * The reclassifier writes a `BrainCandidate` row for every reclassification
 * decision: `drop` / `task` / `edge` actions are auto-applied (the row is
 * inserted with `appliedAt` already set, side-effect performed first);
 * `attribute` and `extract` candidates are inserted with `appliedAt = null`
 * and wait for user confirmation via the `acceptBrainCandidate` chat tool.
 * (`extract` proposes brand-new primitives a memory should be split into —
 * one pending row per target, `targetId` null until the user accepts.)
 *
 * The same table powers `listBrainCandidates` / `/brain recent` (audit log)
 * and the undo path (`undoReclassification` flips `undoneAt` after running
 * the symmetric reversal on the target row).
 *
 * See:
 *   - `docs/architecture/brain/corrections.md` → "D.9 reclassifier"
 *   - `packages/api/migrations/198_brain_candidates.sql` (DDL)
 */

import type { AccessContext } from '../security/access-context.js'

export type BrainCandidateAction = 'drop' | 'task' | 'edge' | 'attribute' | 'extract'

export interface BrainCandidate {
  id: string
  workspaceId: string
  memoryId: string
  suggestedAction: BrainCandidateAction

  /** For task/edge/attribute: the row the reclassification produced (or
   *  proposes to produce for `attribute` candidates pending user accept). */
  targetKind: string | null
  targetId: string | null

  /** Attribute candidates only: the proposed entity-attribute write. */
  suggestedKey: string | null
  suggestedValue: unknown

  /** LLM rationale + self-graded confidence (0-1). */
  reason: string | null
  confidence: number | null

  createdAt: Date

  appliedAt: Date | null
  appliedByUserId: string | null

  dismissedAt: Date | null
  dismissedByUserId: string | null

  undoneAt: Date | null
  undoneByUserId: string | null

  createdByUserId: string
  createdByAssistantId: string | null
}

export interface BrainCandidateCreateParams {
  workspaceId: string
  memoryId: string
  suggestedAction: BrainCandidateAction

  targetKind?: string | null
  targetId?: string | null

  suggestedKey?: string | null
  suggestedValue?: unknown

  reason?: string | null
  confidence?: number | null

  /**
   * When `true`, the row is inserted with `applied_at = now()` and
   * `applied_by_user_id = createdByUserId`. The reclassifier uses this
   * for auto-applied drop/task/edge actions — the side-effect has
   * already been performed; the row is written purely as audit.
   *
   * When `false` (default) the row is inserted in the pending state
   * (applied_at IS NULL). Used for attribute candidates that wait for
   * user confirmation via `acceptBrainCandidate`.
   */
  autoApplied?: boolean

  createdByUserId: string
  createdByAssistantId?: string | null
}

export interface BrainCandidateStore {
  /** Insert a new candidate row. Returns the new id. */
  enqueue(params: BrainCandidateCreateParams): Promise<{ id: string }>

  /** Pending = no applied_at AND no dismissed_at. */
  listPending(
    ctx: AccessContext,
    opts?: { limit?: number },
  ): Promise<BrainCandidate[]>

  /** Recent = any state, ordered by created_at DESC. Used by /brain recent. */
  listRecent(
    ctx: AccessContext,
    opts?: { since?: Date; limit?: number },
  ): Promise<BrainCandidate[]>

  getById(ctx: AccessContext, id: string): Promise<BrainCandidate | null>

  /**
   * Mark `applied_at`. Returns the updated row, or `null` when the
   * candidate doesn't exist under the actor's RLS or is already in a
   * terminal state (applied / dismissed / undone).
   */
  markApplied(id: string, actorUserId: string): Promise<BrainCandidate | null>

  markDismissed(id: string, actorUserId: string): Promise<BrainCandidate | null>

  markUndone(id: string, actorUserId: string): Promise<BrainCandidate | null>
}
