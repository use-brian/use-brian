/**
 * Pending-classifications store interface (port).
 *
 * Probabilistic classifier outputs from B1 (connector adapter) and B5
 * (self-heal worker) land here for user resolution. Inbox-shaped reads
 * by workspace; system-only writes.
 *
 * Implementation: `packages/api/src/db/pending-classifications-store.ts`
 * Spec: docs/architecture/brain/classification/README.md
 *   §Pending-reclassification queue
 */

import type { AccessContext } from '../security/access-context.js'
import type { ClassifierBoundary } from './types.js'

export type PendingClassificationPrimitive = 'entity' | 'edge' | 'memory' | 'episode'
export type PendingClassificationResolution = 'accept' | 'reject' | 'dismiss'
export type PendingClassificationDetectedBy = 'connector' | 'tool' | 'inbox' | 'pipeline_b' | 'self_heal'

export type PendingClassificationRecord = {
  id: string
  workspaceId: string
  primitiveKind: PendingClassificationPrimitive
  targetId: string
  currentValue: string
  suggestedValue: string
  ruleId: string
  confidence: number
  detectedAt: Date
  detectedByBoundary: PendingClassificationDetectedBy
  resolvedAt: Date | null
  resolvedByUserId: string | null
  resolution: PendingClassificationResolution | null
}

export type EnqueuePendingClassification = {
  workspaceId: string
  primitiveKind: PendingClassificationPrimitive
  targetId: string
  currentValue: string
  suggestedValue: string
  ruleId: string
  confidence: number
  detectedByBoundary: PendingClassificationDetectedBy
}

export interface PendingClassificationStore {
  /**
   * Enqueue a suggestion. System-level — no AccessContext, since the
   * callers are connector adapters and the self-heal worker.
   *
   * Idempotency: if an unresolved row already exists for
   * (workspaceId, primitiveKind, targetId, ruleId), the enqueue is a
   * no-op and returns the existing record. This prevents the same
   * suggestion from spamming the inbox across multiple worker ticks.
   */
  enqueue(params: EnqueuePendingClassification): Promise<PendingClassificationRecord>

  /**
   * Inbox read for the workspace — unresolved first, newest-first.
   * Workspace-membership gated via RLS.
   */
  listUnresolvedForWorkspace(
    ctx: AccessContext,
    opts?: { limit?: number; primitiveKind?: PendingClassificationPrimitive },
  ): Promise<PendingClassificationRecord[]>

  /**
   * Mark a suggestion resolved. Workspace-membership gated.
   *
   * The actual application of the suggestion (calling reclassifyEntityKind,
   * promoting to CRM, etc.) is the caller's responsibility. This method
   * only flips the queue row's resolution state for audit.
   */
  resolve(
    actorUserId: string,
    id: string,
    resolution: PendingClassificationResolution,
  ): Promise<PendingClassificationRecord | null>

  /**
   * Auto-dismiss rows older than `staleAfterDays`. Called by a periodic
   * cleanup task — typically same cadence as the self-heal worker.
   * Returns the count of rows dismissed.
   */
  autoDismissStale(staleAfterDays: number): Promise<number>

  /**
   * Lookup a specific row by id (for testing and the resolution flow).
   * Workspace-membership gated.
   */
  getById(ctx: AccessContext, id: string): Promise<PendingClassificationRecord | null>
}
