/**
 * Memory → entity.attributes promotion path (WU-6.10).
 *
 * Implements the SV 2026-05-14 visibility-promotion lock from
 * `docs/architecture/brain/corrections.md` §"Visibility promotion":
 *
 *   "Per-assistant inference labels stored as memories scoped
 *    (NULL, assistant_id) can be promoted to workspace-shared
 *    entities.attributes via D.7 supersession on the entity row + the
 *    Promote-to-team rule in permissions.md (only the original author
 *    may widen visibility)."
 *
 * Pure orchestration: store access is supplied via narrow port
 * interfaces so this module stays DB-free per the package's pure-core
 * contract (see `packages/core/CLAUDE.md`).
 *
 * The D.7 supersession write itself is delegated to a single
 * `supersedeEntity` port: implementations are expected to atomically
 * (a) INSERT a new entity row carrying the merged `attributes`, then
 * (b) UPDATE the old row with `valid_to = now()` and
 * `superseded_by = <new id>`. The memory row is left untouched — it
 * persists as provenance.
 */

import type { Sensitivity } from '../security/sensitivity.js'

// ── Port: read slice of the source memory ────────────────────────────

export interface MemoryForPromotion {
  id: string
  /** Visibility double — narrowing component (user side). */
  userId: string | null
  /** Visibility double — narrowing component (assistant side). */
  assistantId: string | null
  summary: string
  detail: string | null
  sensitivity: Sensitivity
  /** Author — gate key for Promote-to-team. */
  createdByUserId: string
  validTo: Date | null
  retractedAt: Date | null
  workspaceId: string
}

// ── Port: read slice of the target entity row ────────────────────────

export interface EntitySnapshotForPromotion {
  id: string
  workspaceId: string
  attributes: Record<string, unknown>
  validTo: Date | null
  retractedAt: Date | null
}

// ── Port: the D.7 supersession write primitive ───────────────────────

export type SupersedeEntityFn = (params: {
  oldEntityId: string
  mergedAttributes: Record<string, unknown>
  promotedByUserId: string
  sourceMemoryId: string
}) => Promise<{ newEntityId: string }>

export interface MemoryToEntityPromotionPorts {
  getMemoryForPromotion(memoryId: string): Promise<MemoryForPromotion | null>
  getEntityForPromotion(entityId: string): Promise<EntitySnapshotForPromotion | null>
  supersedeEntity: SupersedeEntityFn
}

// ── Params + result ──────────────────────────────────────────────────

export interface PromoteMemoryToEntityParams {
  memoryId: string
  targetEntityId: string
  /** JSONB key under entities.attributes. Must be non-empty and not start with `__`. */
  attributeKey: string
  /** JSONB-serialisable value written under `attributeKey`. */
  attributeValue: unknown
  /** Caller. Must equal `memory.createdByUserId` (Promote-to-team gate). */
  actorUserId: string
}

export interface PromotionResult {
  oldEntityId: string
  newEntityId: string
  attributeKey: string
}

// ── Failure model ────────────────────────────────────────────────────

export type PromotionFailureReason =
  | 'memory_not_found'
  | 'memory_retracted'
  | 'memory_superseded'
  | 'entity_not_found'
  | 'entity_retracted'
  | 'entity_superseded'
  | 'workspace_mismatch'
  | 'not_author'
  | 'not_widening'
  | 'invalid_attribute_key'

export class PromotionDenied extends Error {
  readonly reason: PromotionFailureReason
  constructor(reason: PromotionFailureReason, message?: string) {
    super(message ?? reason)
    this.name = 'PromotionDenied'
    this.reason = reason
  }
}

// ── Orchestration ────────────────────────────────────────────────────

export async function promoteMemoryToEntity(
  ports: MemoryToEntityPromotionPorts,
  params: PromoteMemoryToEntityParams,
): Promise<PromotionResult> {
  const memory = await ports.getMemoryForPromotion(params.memoryId)
  if (!memory) throw new PromotionDenied('memory_not_found')
  if (memory.retractedAt) throw new PromotionDenied('memory_retracted')
  if (memory.validTo) throw new PromotionDenied('memory_superseded')

  if (memory.createdByUserId !== params.actorUserId) {
    throw new PromotionDenied('not_author')
  }

  if (memory.userId === null && memory.assistantId === null) {
    throw new PromotionDenied('not_widening')
  }

  const entity = await ports.getEntityForPromotion(params.targetEntityId)
  if (!entity) throw new PromotionDenied('entity_not_found')
  if (entity.retractedAt) throw new PromotionDenied('entity_retracted')
  if (entity.validTo) throw new PromotionDenied('entity_superseded')

  if (entity.workspaceId !== memory.workspaceId) {
    throw new PromotionDenied('workspace_mismatch')
  }

  if (!isValidAttributeKey(params.attributeKey)) {
    throw new PromotionDenied('invalid_attribute_key')
  }

  const mergedAttributes: Record<string, unknown> = {
    ...entity.attributes,
    [params.attributeKey]: params.attributeValue,
  }

  const { newEntityId } = await ports.supersedeEntity({
    oldEntityId: entity.id,
    mergedAttributes,
    promotedByUserId: params.actorUserId,
    sourceMemoryId: memory.id,
  })

  return {
    oldEntityId: entity.id,
    newEntityId,
    attributeKey: params.attributeKey,
  }
}

function isValidAttributeKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false
  if (key.startsWith('__')) return false
  return true
}
