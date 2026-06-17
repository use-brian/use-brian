/**
 * Classifier self-heal worker — retroactively reclassifies existing
 * entity rows when classifier rules added/improved since the row was
 * first written.
 *
 * Per-tick: scan workspaces; for each, scan entities by centrality;
 * build a candidate from the row; call `classifier.decide()`.
 *   - deterministic mismatch (circuit-breaker-gated): silent supersede
 *   - probabilistic mismatch: enqueue in pending-classifications inbox
 *
 * Spec: docs/architecture/brain/classification/README.md §Self-heal worker
 *       docs/architecture/brain/classification/operational.md §O2
 */

import type { EntityKind, EntityRecord, EntityStore } from '../../entities/types.js'
import type { ClassificationAnalytics } from '../analytics.js'
import type { CircuitBreaker } from '../circuit-breaker.js'
import type { Classifier } from '../types.js'
import type { PendingClassificationStore } from '../pending-queue.js'

// ── Ports the worker needs from the API layer ───────────────────────

/**
 * System-level paginated scanner for entities. The worker iterates a
 * workspace's entities ordered by centrality (highest-impact first)
 * via a cursor.
 */
export type EntityCentralityScannerPort = {
  scanByCentrality(
    workspaceId: string,
    opts: { afterId?: string; limit: number },
  ): Promise<EntityRecord[]>
}

/**
 * Returns workspaces eligible for self-heal — every workspace with at
 * least one entity, paired with an `actorUserId` (typically the
 * workspace owner) used as the actor when reclassifying entities.
 * The actorUserId is required for `reclassifyEntityKind` /
 * `promoteEntityToCrm` (both use `queryWithRLS`).
 *
 * Iteration order isn't load-bearing; the scanner inside each
 * workspace handles ordering.
 */
export type ClassifierSelfHealWorkspaceLister = () => Promise<Array<{ workspaceId: string; actorUserId: string }>>

/**
 * Reclassify-or-promote port. `reclassifyEntityKind` handles non-CRM
 * kinds; `promoteEntityToCrm` handles project/product/repository →
 * person/company/deal. The worker picks the right one based on
 * source/target kinds.
 */
export type EntityKindReclassifierPort = {
  reclassifyEntityKind(
    actorUserId: string,
    id: string,
    newKind: EntityKind,
  ): Promise<EntityRecord | null>
  promoteEntityToCrm(
    actorUserId: string,
    id: string,
    targetKind: 'person' | 'company' | 'deal',
  ): Promise<EntityRecord | null>
}

// ── Worker shape ─────────────────────────────────────────────────────

export type ClassifierSelfHealWorkerOptions = {
  classifier: Classifier<EntityKind>
  entities: EntityStore                    // for findByCanonicalIdSystem
  scanner: EntityCentralityScannerPort
  reclassifier: EntityKindReclassifierPort
  pendingQueue: PendingClassificationStore
  workspaces: ClassifierSelfHealWorkspaceLister
  circuitBreaker?: CircuitBreaker
  analytics?: ClassificationAnalytics

  /** Tick cadence. Default 6h — kind misclassification isn't urgent. */
  intervalMs?: number
  /** Entities scanned per workspace per tick. Default 100. */
  batchSize?: number
  /** Confidence threshold for queue-enqueue. Default 0.7. */
  hintThreshold?: number
  /**
   * Fallback actor id when a workspace's lister entry omits one (rare —
   * normally each workspace ships with its owner's userId).
   */
  systemActorUserId?: string
  /** Override Date.now for tests. */
  now?: () => Date
  /** Error hook — default logs to console.warn. */
  onError?: (err: unknown, ctx: { phase: string; workspaceId?: string; entityId?: string }) => void
}

export type ClassifierSelfHealTickResult = {
  workspacesScanned: number
  entitiesScanned: number
  overrides: number
  enqueued: number
  skippedSuspended: number
  errors: number
}

export type ClassifierSelfHealWorker = {
  tick(): Promise<ClassifierSelfHealTickResult>
  start(): void
  stop(): void
  isRunning(): boolean
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_HINT_THRESHOLD = 0.7

const CRM_KINDS = new Set<EntityKind>(['person', 'company', 'deal'])

export function createClassifierSelfHealWorker(
  options: ClassifierSelfHealWorkerOptions,
): ClassifierSelfHealWorker {
  const {
    classifier,
    scanner,
    reclassifier,
    pendingQueue,
    workspaces,
    circuitBreaker,
    analytics,
    systemActorUserId: fallbackActorUserId,
    intervalMs = DEFAULT_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    hintThreshold = DEFAULT_HINT_THRESHOLD,
    onError = (err, ctx) =>
      console.warn(
        `[classifier-self-heal] ${ctx.phase} failed${ctx.workspaceId ? ` (ws=${ctx.workspaceId})` : ''}${ctx.entityId ? ` (entity=${ctx.entityId})` : ''}: ${err instanceof Error ? err.message : String(err)}`,
      ),
  } = options

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function processEntity(
    entity: EntityRecord,
    actorUserId: string,
    result: ClassifierSelfHealTickResult,
  ): Promise<void> {
    try {
      const decision = classifier.decide(
        {
          primary: entity.displayName,
          canonical_id: entity.canonicalId,
          attributes: entity.attributes,
          proposed: entity.kind,
        },
        'self_heal',
      )

      if (decision.kind === 'override') {
        const match = decision.match
        if (match.value === entity.kind) return  // already correct

        // Circuit breaker check
        if (
          circuitBreaker &&
          (await circuitBreaker.isTripped(entity.workspaceId, match.rule_id))
        ) {
          result.skippedSuspended++
          return
        }

        const isCrmTarget = CRM_KINDS.has(match.value)
        const isCrmSource = CRM_KINDS.has(entity.kind)
        if (isCrmSource && !isCrmTarget) {
          // Demote-from-CRM is unsupported (entities-store.ts:1317-1321).
          // Surface for manual resolution; don't auto-apply.
          analytics?.demoteBlocked(actorUserId, {
            rule_id: match.rule_id,
            entity_id: entity.id,
            current_kind: entity.kind,
            suggested_kind: match.value,
            boundary: 'self_heal',
          })
          await pendingQueue.enqueue({
            workspaceId: entity.workspaceId,
            primitiveKind: 'entity',
            targetId: entity.id,
            currentValue: entity.kind,
            suggestedValue: match.value,
            ruleId: match.rule_id,
            confidence: match.confidence,
            detectedByBoundary: 'self_heal',
          })
          result.enqueued++
          return
        }

        try {
          if (isCrmTarget && !isCrmSource) {
            await reclassifier.promoteEntityToCrm(
              actorUserId,
              entity.id,
              match.value as 'person' | 'company' | 'deal',
            )
          } else {
            await reclassifier.reclassifyEntityKind(actorUserId, entity.id, match.value)
          }
          analytics?.applied(actorUserId, {
            primitive_kind: 'entity',
            target_id: entity.id,
            rule_id: match.rule_id,
            tier: 'deterministic',
            confidence: match.confidence,
            before_value: entity.kind,
            after_value: match.value,
            boundary: 'self_heal',
          })
          result.overrides++
          if (circuitBreaker) {
            await circuitBreaker.record(entity.workspaceId, match.rule_id, 'self_heal')
          }
        } catch (err) {
          onError(err, { phase: 'reclassify', workspaceId: entity.workspaceId, entityId: entity.id })
          result.errors++
        }
        return
      }

      if (decision.kind === 'hint') {
        const top = decision.matches[0]
        if (!top || top.confidence < hintThreshold) return
        if (top.value === entity.kind) return
        try {
          await pendingQueue.enqueue({
            workspaceId: entity.workspaceId,
            primitiveKind: 'entity',
            targetId: entity.id,
            currentValue: entity.kind,
            suggestedValue: top.value,
            ruleId: top.rule_id,
            confidence: top.confidence,
            detectedByBoundary: 'self_heal',
          })
          result.enqueued++
        } catch (err) {
          onError(err, { phase: 'enqueue', workspaceId: entity.workspaceId, entityId: entity.id })
          result.errors++
        }
      }
    } catch (err) {
      onError(err, { phase: 'decide', workspaceId: entity.workspaceId, entityId: entity.id })
      result.errors++
    }
  }

  async function tickInner(): Promise<ClassifierSelfHealTickResult> {
    const result: ClassifierSelfHealTickResult = {
      workspacesScanned: 0,
      entitiesScanned: 0,
      overrides: 0,
      enqueued: 0,
      skippedSuspended: 0,
      errors: 0,
    }
    let entries: Array<{ workspaceId: string; actorUserId: string }>
    try {
      entries = await workspaces()
    } catch (err) {
      onError(err, { phase: 'list-workspaces' })
      return result
    }

    for (const { workspaceId, actorUserId: entryActor } of entries) {
      const actorUserId = entryActor || fallbackActorUserId
      if (!actorUserId) {
        onError(new Error('no actorUserId for workspace'), { phase: 'scan', workspaceId })
        result.errors++
        continue
      }
      result.workspacesScanned++
      try {
        const batch = await scanner.scanByCentrality(workspaceId, { limit: batchSize })
        for (const entity of batch) {
          result.entitiesScanned++
          await processEntity(entity, actorUserId, result)
        }
      } catch (err) {
        onError(err, { phase: 'scan', workspaceId })
        result.errors++
      }
    }
    return result
  }

  return {
    tick: tickInner,
    start() {
      if (running) return
      running = true
      const loop = async () => {
        try {
          await tickInner()
        } catch (err) {
          onError(err, { phase: 'tick-toplevel' })
        }
      }
      void loop()
      timer = setInterval(() => void loop(), intervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      running = false
    },
    isRunning() {
      return running
    },
  }
}
