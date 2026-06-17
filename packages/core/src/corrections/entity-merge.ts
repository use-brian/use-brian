/**
 * D-locks D.1 (entity merge + cascade) and D.2 (undoMerge within 7-day
 * window). Spec: docs/architecture/brain/corrections.md §D.1, §D.2.
 *
 * Pure orchestration module. All persistence is delegated to injected
 * `EntityMergeRepository` + `SpecializationCascadeRepository` ports. No
 * DB driver, no SQL, no I/O in this file. The DB adapter that fulfils
 * these ports lives in the API package (separate work unit — see plan
 * "Reported, not fixed" §4).
 *
 * Edges are intentionally NOT touched at merge or undo time. Auto-redirect
 * via `superseded_by` is retrieval's concern (corrections.md §"Edge
 * handling", retrieval.md §"merged-entity ID resolution").
 */

// ── Modes & inputs ──────────────────────────────────────────────────

export type ReconciliationMode =
  | 'auto-merge-with-prompt'
  | 'survivor-wins'
  | 'merged-wins'
  | 'manual-per-field'

/**
 * Operator decision for a single conflicting field. `field` is either a
 * key inside `attributes` or one of the reserved structural slots
 * (`'tags'`, `'display_name'`). Nested paths are out of scope for v1.
 */
export interface ReconciliationOverride {
  field: string
  resolved: unknown
}

/**
 * Specialization (CRM-layer) pointer. The merge module is kind-agnostic
 * — caller resolves which specialization the merged entity has and
 * passes the two row ids.
 */
export interface SpecializationPointer {
  sourceKind: string
  sourceId: string
  survivorSourceId: string
}

export interface MergeEntitiesArgs {
  workspaceId: string
  survivingId: string
  mergedId: string
  actorUserId: string
  reason?: string
  mode?: ReconciliationMode
  overrides?: readonly ReconciliationOverride[]
  cascade?: boolean
  specializationPointer?: SpecializationPointer
}

export interface UndoMergeArgs {
  workspaceId: string
  mergeId: string
  actorUserId: string
  reason?: string
  now?: Date
}

// ── Records & snapshots ─────────────────────────────────────────────

export interface EntityMergeSnapshot {
  entityId: string
  displayName: string
  attributes: Record<string, unknown>
  tags: readonly string[]
  validTo: Date | null
  supersededBy: string | null
  workspaceId: string
}

export interface EntityMergeRecord {
  id: string
  workspaceId: string
  survivingId: string
  mergedId: string
  mergedAt: Date
  mergedBy: string | null
  reason: string | null
  mergedAttributesSnapshot: EntityMergeSnapshot
  survivingAttributesPreMerge: EntityMergeSnapshot | null
  mergedSpecializationPointer: SpecializationPointer | null
  cascadeApplied: boolean
  reconciliationOverrides: readonly ReconciliationOverride[] | null
}

// ── Failure codes ───────────────────────────────────────────────────

export type MergeFailureCode =
  | 'cross_workspace_rejected'
  | 'entity_not_found'
  | 'entity_inactive'
  | 'self_merge'
  | 'conflict_requires_resolution'

export type UndoFailureCode =
  | 'merge_not_found'
  | 'snapshot_unavailable'
  | 'merge_too_old'
  | 'survivor_superseded'
  | 'cascade_target_missing'

export class EntityMergeError extends Error {
  readonly code: MergeFailureCode
  constructor(code: MergeFailureCode, message: string) {
    super(message)
    this.name = 'EntityMergeError'
    this.code = code
  }
}

export class UndoMergeError extends Error {
  readonly code: UndoFailureCode
  constructor(code: UndoFailureCode, message: string) {
    super(message)
    this.name = 'UndoMergeError'
    this.code = code
  }
}

// ── Ports (implemented by the DB adapter, not by this module) ───────

export interface ApplyMergeInput {
  workspaceId: string
  survivingId: string
  mergedId: string
  mergedBy: string
  reason: string | null
  reconciledAttributes: Record<string, unknown>
  reconciledTags: readonly string[]
  mergedAttributesSnapshot: EntityMergeSnapshot
  survivingAttributesPreMerge: EntityMergeSnapshot
  mergedSpecializationPointer: SpecializationPointer | null
  cascadeApplied: boolean
  reconciliationOverrides: readonly ReconciliationOverride[] | null
  now: Date
}

export interface ApplyUndoMergeInput {
  mergeRecord: EntityMergeRecord
  actorUserId: string
  reason: string | null
  cascadeReversed: boolean
  now: Date
}

export interface EntityMergeRepository {
  readEntityForMerge(
    workspaceId: string,
    entityId: string,
  ): Promise<EntityMergeSnapshot | null>

  applyMerge(input: ApplyMergeInput): Promise<EntityMergeRecord>

  applyUndoMerge(input: ApplyUndoMergeInput): Promise<void>

  findMergeById(
    workspaceId: string,
    mergeId: string,
  ): Promise<EntityMergeRecord | null>

  isEntityActive(workspaceId: string, entityId: string): Promise<boolean>
}

export interface SpecializationCascadeRepository {
  applyCascade(input: {
    sourceKind: string
    mergedSourceId: string
    survivorSourceId: string
    now: Date
  }): Promise<void>

  reverseCascade(input: {
    sourceKind: string
    mergedSourceId: string
  }): Promise<'reversed' | 'missing'>
}

export interface EntityMergeDeps {
  repo: EntityMergeRepository
  cascade?: SpecializationCascadeRepository
  clock?: () => Date
}

// ── Reconciliation algebra (pure) ───────────────────────────────────

/**
 * Fields that require explicit operator resolution in
 * `auto-merge-with-prompt` mode when both sides have a populated value.
 * Tags always union (handled separately by `reconcileTags`).
 */
export const RESERVED_RECONCILIATION_FIELDS: readonly string[] = [
  'email',
  'phone',
  'domain',
]

export type ConflictSeverity = 'auto_resolved' | 'requires_resolution'

export interface ConflictReport {
  field: string
  severity: ConflictSeverity
  survivorValue: unknown
  mergedValue: unknown
  resolvedValue?: unknown
}

export interface ReconciliationResult {
  result: Record<string, unknown>
  conflicts: readonly ConflictReport[]
}

function isPopulated(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

function findOverride(
  overrides: readonly ReconciliationOverride[],
  field: string,
): ReconciliationOverride | undefined {
  return overrides.find(o => o.field === field)
}

export function reconcileAttributes(
  survivor: Record<string, unknown>,
  mergedAway: Record<string, unknown>,
  mode: ReconciliationMode,
  overrides: readonly ReconciliationOverride[] = [],
): ReconciliationResult {
  const result: Record<string, unknown> = {}
  const conflicts: ConflictReport[] = []
  const keys = new Set<string>([...Object.keys(survivor), ...Object.keys(mergedAway)])

  for (const key of keys) {
    const sHas = Object.prototype.hasOwnProperty.call(survivor, key)
    const mHas = Object.prototype.hasOwnProperty.call(mergedAway, key)
    const sVal = survivor[key]
    const mVal = mergedAway[key]
    const override = findOverride(overrides, key)

    if (override !== undefined) {
      result[key] = override.resolved
      if (sHas && mHas && sVal !== mVal) {
        conflicts.push({
          field: key,
          severity: 'auto_resolved',
          survivorValue: sVal,
          mergedValue: mVal,
          resolvedValue: override.resolved,
        })
      }
      continue
    }

    if (sHas && !mHas) {
      result[key] = sVal
      continue
    }
    if (mHas && !sHas) {
      result[key] = mVal
      continue
    }

    // Both sides have the key.
    if (sVal === mVal) {
      result[key] = sVal
      continue
    }

    // Real conflict — resolve per mode.
    switch (mode) {
      case 'survivor-wins':
        result[key] = sVal
        conflicts.push({
          field: key,
          severity: 'auto_resolved',
          survivorValue: sVal,
          mergedValue: mVal,
          resolvedValue: sVal,
        })
        break
      case 'merged-wins':
        result[key] = mVal
        conflicts.push({
          field: key,
          severity: 'auto_resolved',
          survivorValue: sVal,
          mergedValue: mVal,
          resolvedValue: mVal,
        })
        break
      case 'manual-per-field':
        // Caller must supply an override for every conflict.
        conflicts.push({
          field: key,
          severity: 'requires_resolution',
          survivorValue: sVal,
          mergedValue: mVal,
        })
        break
      case 'auto-merge-with-prompt': {
        const isReserved = RESERVED_RECONCILIATION_FIELDS.includes(key)
        const bothPopulated = isPopulated(sVal) && isPopulated(mVal)
        if (isReserved && bothPopulated) {
          conflicts.push({
            field: key,
            severity: 'requires_resolution',
            survivorValue: sVal,
            mergedValue: mVal,
          })
        } else if (isPopulated(sVal) && !isPopulated(mVal)) {
          result[key] = sVal
          conflicts.push({
            field: key,
            severity: 'auto_resolved',
            survivorValue: sVal,
            mergedValue: mVal,
            resolvedValue: sVal,
          })
        } else if (!isPopulated(sVal) && isPopulated(mVal)) {
          result[key] = mVal
          conflicts.push({
            field: key,
            severity: 'auto_resolved',
            survivorValue: sVal,
            mergedValue: mVal,
            resolvedValue: mVal,
          })
        } else {
          // Both populated, non-reserved → defer to operator.
          conflicts.push({
            field: key,
            severity: 'requires_resolution',
            survivorValue: sVal,
            mergedValue: mVal,
          })
        }
        break
      }
    }
  }

  return { result, conflicts }
}

/**
 * Case-insensitive tag union. Preserves survivor's order, appends new
 * tags from merged-away in their original order.
 */
export function reconcileTags(
  survivorTags: readonly string[],
  mergedTags: readonly string[],
): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of survivorTags) {
    const key = t.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(t)
    }
  }
  for (const t of mergedTags) {
    const key = t.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(t)
    }
  }
  return out
}

const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function isWithinUndoWindow(mergedAt: Date, now: Date): boolean {
  return now.getTime() - mergedAt.getTime() < UNDO_WINDOW_MS
}

// ── Orchestration ───────────────────────────────────────────────────

export async function mergeEntities(
  args: MergeEntitiesArgs,
  deps: EntityMergeDeps,
): Promise<EntityMergeRecord> {
  const clock = deps.clock ?? (() => new Date())
  const now = clock()

  if (args.survivingId === args.mergedId) {
    throw new EntityMergeError(
      'self_merge',
      'survivingId and mergedId must differ',
    )
  }

  const [survivor, mergedAway] = await Promise.all([
    deps.repo.readEntityForMerge(args.workspaceId, args.survivingId),
    deps.repo.readEntityForMerge(args.workspaceId, args.mergedId),
  ])
  if (!survivor || !mergedAway) {
    throw new EntityMergeError(
      'entity_not_found',
      'one or both entities do not exist in this workspace',
    )
  }
  if (
    survivor.workspaceId !== args.workspaceId
    || mergedAway.workspaceId !== args.workspaceId
  ) {
    throw new EntityMergeError(
      'cross_workspace_rejected',
      'cross-workspace merge is not permitted',
    )
  }
  if (survivor.validTo !== null || mergedAway.validTo !== null) {
    throw new EntityMergeError(
      'entity_inactive',
      'cannot merge entities that are already superseded or retracted',
    )
  }

  const mode = args.mode ?? 'auto-merge-with-prompt'
  const overrides = args.overrides ?? []
  const { result: reconciledAttributes, conflicts } = reconcileAttributes(
    survivor.attributes,
    mergedAway.attributes,
    mode,
    overrides,
  )
  if (conflicts.some(c => c.severity === 'requires_resolution')) {
    throw new EntityMergeError(
      'conflict_requires_resolution',
      'one or more conflicting fields require an explicit operator decision',
    )
  }

  const reconciledTags = reconcileTags(survivor.tags, mergedAway.tags)
  const cascadeRequested = args.cascade ?? true
  const cascadeApplied = cascadeRequested && args.specializationPointer != null

  const record = await deps.repo.applyMerge({
    workspaceId: args.workspaceId,
    survivingId: args.survivingId,
    mergedId: args.mergedId,
    mergedBy: args.actorUserId,
    reason: args.reason ?? null,
    reconciledAttributes,
    reconciledTags,
    mergedAttributesSnapshot: mergedAway,
    survivingAttributesPreMerge: survivor,
    mergedSpecializationPointer: args.specializationPointer ?? null,
    cascadeApplied,
    reconciliationOverrides: overrides.length > 0 ? overrides : null,
    now,
  })

  if (cascadeApplied && deps.cascade && args.specializationPointer) {
    await deps.cascade.applyCascade({
      sourceKind: args.specializationPointer.sourceKind,
      mergedSourceId: args.specializationPointer.sourceId,
      survivorSourceId: args.specializationPointer.survivorSourceId,
      now,
    })
  }

  return record
}

export async function undoMerge(
  args: UndoMergeArgs,
  deps: EntityMergeDeps,
): Promise<void> {
  const clock = deps.clock ?? (() => new Date())
  const now = args.now ?? clock()

  const record = await deps.repo.findMergeById(args.workspaceId, args.mergeId)
  if (!record) {
    throw new UndoMergeError(
      'merge_not_found',
      'no merge record matches that id in this workspace',
    )
  }
  if (
    !record.mergedAttributesSnapshot
    || !record.survivingAttributesPreMerge
  ) {
    throw new UndoMergeError(
      'snapshot_unavailable',
      'merge record predates snapshot capture; manual rebuild required',
    )
  }
  if (!isWithinUndoWindow(record.mergedAt, now)) {
    throw new UndoMergeError(
      'merge_too_old',
      'merge is outside the 7-day undo window',
    )
  }
  if (!(await deps.repo.isEntityActive(args.workspaceId, record.survivingId))) {
    throw new UndoMergeError(
      'survivor_superseded',
      'survivor has been further superseded; undo chain in reverse order first',
    )
  }

  let cascadeReversed = false
  if (record.cascadeApplied && record.mergedSpecializationPointer && deps.cascade) {
    const outcome = await deps.cascade.reverseCascade({
      sourceKind: record.mergedSpecializationPointer.sourceKind,
      mergedSourceId: record.mergedSpecializationPointer.sourceId,
    })
    if (outcome === 'missing') {
      throw new UndoMergeError(
        'cascade_target_missing',
        'specialization row was hard-deleted; manual rebuild required',
      )
    }
    cascadeReversed = true
  }

  await deps.repo.applyUndoMerge({
    mergeRecord: record,
    actorUserId: args.actorUserId,
    reason: args.reason ?? null,
    cascadeReversed,
    now,
  })
}
