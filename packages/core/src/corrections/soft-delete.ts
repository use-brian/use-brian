/**
 * D-lock D.4 (universal soft delete contract). Spec:
 * docs/architecture/brain/corrections.md §D.4.
 *
 * Pure orchestration module. All persistence is delegated to an
 * injected `SoftDeleteRepository` port. No DB driver, no SQL, no I/O
 * in this file. The DB adapter that fulfils the port lives in the API
 * package (separate work unit).
 *
 * Three orchestrators, one shared port:
 *
 *  • `softDelete` — bi-temporal supersession (`valid_to = now`) for
 *    every primitive **except** memory (use `retractMemory` from
 *    `./retraction.ts`) and workspace_file (physical-delete exception,
 *    see below).
 *
 *  • `hardPurge` — permanent removal + `{primitive}_purges` audit row.
 *    The adapter additionally removes the GCS object for
 *    workspace_file. Reserved for explicit user purge intent, GDPR,
 *    or operator retention cleanup.
 *
 *  • `deleteByAuthor` — bypasses the read predicate via
 *    `readForAuthorshipDelete` so an author retains delete control of
 *    their own rows even after a clearance demotion that would
 *    otherwise hide the row from them. The audit log records the
 *    deletion without surfacing row content.
 *
 * Why memory is excluded: memory's `retracted_at` semantics
 * ("was never correct") are distinct from `valid_to`-only soft delete
 * ("was true, then changed"). Conflating them defeats D.3's
 * re-extraction protection.
 *
 * Why files are an exception: bytes live in GCS — storage cost, not
 * just a Postgres row. Accidentally-uploaded files have no semantic
 * value to preserve, and GDPR pushes toward physical removal.
 * `softDelete` refuses workspace_file with `file_physical_delete_only`;
 * callers route to `hardPurge`.
 *
 * Out of scope (enforced elsewhere):
 *
 *  • Permission tiers (member vs admin vs operator + ticket per D.8)
 *    are at the tool layer. This module enforces only the authorship
 *    invariant for `deleteByAuthor`.
 *
 *  • Confirmation flow scaling per D.8 is at the tool layer.
 *
 *  • Retention thresholds (memory 180d, entities 365d, tasks 90d, etc.)
 *    are operator-cleanup cadence, not enforced here.
 */

// ── Primitive discriminator ─────────────────────────────────────────

/**
 * Primitives that participate in the universal soft-delete contract.
 *
 * Memory is intentionally absent — use `retractMemory` /
 * `purgeMemory` from `./retraction.ts` instead. Memory's correction
 * semantics distinguish "was never correct" (retracted_at) from
 * "was true, then changed" (valid_to alone); a generic soft-delete
 * would conflate the two.
 */
export type SoftDeletePrimitive =
  | 'entity'
  | 'task'
  | 'kb_chunk'
  | 'workspace_file'
  | 'contact'
  | 'company'
  | 'deal'
  | 'episode'

/**
 * Primitives whose canonical delete path is physical removal. Today
 * this is only `workspace_file` (GCS bytes + row).
 */
export const PRIMITIVES_WITH_PHYSICAL_DELETE: readonly SoftDeletePrimitive[] = [
  'workspace_file',
] as const

export function isPhysicalDeleteOnly(p: SoftDeletePrimitive): boolean {
  return PRIMITIVES_WITH_PHYSICAL_DELETE.includes(p)
}

// ── Snapshots & args ────────────────────────────────────────────────

export interface RowSnapshot {
  primitive: SoftDeletePrimitive
  rowId: string
  workspaceId: string
  validTo: Date | null
  retractedAt: Date | null
  createdByUserId: string | null
}

export interface SoftDeleteArgs {
  primitive: SoftDeletePrimitive
  workspaceId: string
  rowId: string
  actorUserId: string
  reason: string
}

export interface HardPurgeArgs {
  primitive: SoftDeletePrimitive
  workspaceId: string
  rowId: string
  actorUserId: string
  reason: string
  /** Required when triggered by an operator (D.8 escape hatch). */
  ticketReference?: string
}

export interface DeleteByAuthorArgs {
  primitive: SoftDeletePrimitive
  workspaceId: string
  rowId: string
  actorUserId: string
  reason: string
}

// ── Results ─────────────────────────────────────────────────────────

export interface SoftDeleteResult {
  primitive: SoftDeletePrimitive
  rowId: string
  deletedAt: Date
}

export interface HardPurgeResult {
  primitive: SoftDeletePrimitive
  rowId: string
  purgedAt: Date
}

// ── Failure model ───────────────────────────────────────────────────

export type SoftDeleteFailureCode =
  | 'row_not_found'
  | 'workspace_mismatch'
  | 'already_soft_deleted'
  | 'already_retracted'
  | 'file_physical_delete_only'
  | 'reason_required'

export type HardPurgeFailureCode =
  | 'row_not_found'
  | 'workspace_mismatch'
  | 'reason_required'

export type DeleteByAuthorFailureCode =
  | 'row_not_found'
  | 'workspace_mismatch'
  | 'not_author'
  | 'already_soft_deleted'
  | 'already_retracted'
  | 'reason_required'
  | 'file_physical_delete_only'

export class SoftDeleteError extends Error {
  readonly code: SoftDeleteFailureCode
  constructor(code: SoftDeleteFailureCode, message: string) {
    super(message)
    this.name = 'SoftDeleteError'
    this.code = code
  }
}

export class HardPurgeError extends Error {
  readonly code: HardPurgeFailureCode
  constructor(code: HardPurgeFailureCode, message: string) {
    super(message)
    this.name = 'HardPurgeError'
    this.code = code
  }
}

export class DeleteByAuthorError extends Error {
  readonly code: DeleteByAuthorFailureCode
  constructor(code: DeleteByAuthorFailureCode, message: string) {
    super(message)
    this.name = 'DeleteByAuthorError'
    this.code = code
  }
}

// ── Ports (implemented by the DB adapter, not by this module) ───────

export interface ApplySoftDeleteInput {
  primitive: SoftDeletePrimitive
  workspaceId: string
  rowId: string
  actorUserId: string
  reason: string
  now: Date
}

export interface ApplyHardPurgeInput {
  primitive: SoftDeletePrimitive
  workspaceId: string
  rowId: string
  actorUserId: string
  reason: string
  ticketReference: string | null
  snapshot: RowSnapshot
  now: Date
}

export interface SoftDeleteRepository {
  /**
   * Standard read for the soft-delete path. Adapter may apply the
   * sensitivity / visibility predicate — caller is responsible for
   * routing through tool-layer clearance checks.
   */
  readForSoftDelete(
    primitive: SoftDeletePrimitive,
    workspaceId: string,
    rowId: string,
  ): Promise<RowSnapshot | null>

  /**
   * Bypass-the-read read for the D.4 authorship-delete clause. Adapter
   * loads by authorship index without applying sensitivity / visibility
   * filters so demoted authors can still find and delete their own
   * rows. Returns the same `RowSnapshot` shape.
   */
  readForAuthorshipDelete(
    primitive: SoftDeletePrimitive,
    workspaceId: string,
    rowId: string,
  ): Promise<RowSnapshot | null>

  applySoftDelete(input: ApplySoftDeleteInput): Promise<void>

  applyHardPurge(input: ApplyHardPurgeInput): Promise<void>
}

export interface SoftDeleteDeps {
  repo: SoftDeleteRepository
  clock?: () => Date
}

// ── Guards (pure) ───────────────────────────────────────────────────

function isNonEmpty(s: string | undefined | null): s is string {
  return typeof s === 'string' && s.trim().length > 0
}

// ── Orchestration ───────────────────────────────────────────────────

export async function softDelete(
  args: SoftDeleteArgs,
  deps: SoftDeleteDeps,
): Promise<SoftDeleteResult> {
  if (!isNonEmpty(args.reason)) {
    throw new SoftDeleteError(
      'reason_required',
      'reason must be a non-empty string',
    )
  }
  if (isPhysicalDeleteOnly(args.primitive)) {
    throw new SoftDeleteError(
      'file_physical_delete_only',
      `${args.primitive} cannot be soft-deleted; use hardPurge`,
    )
  }

  const snapshot = await deps.repo.readForSoftDelete(
    args.primitive,
    args.workspaceId,
    args.rowId,
  )
  if (!snapshot) {
    throw new SoftDeleteError(
      'row_not_found',
      `no ${args.primitive} with that id in this workspace`,
    )
  }
  if (snapshot.workspaceId !== args.workspaceId) {
    throw new SoftDeleteError(
      'workspace_mismatch',
      'row belongs to a different workspace',
    )
  }
  if (snapshot.validTo !== null) {
    throw new SoftDeleteError(
      'already_soft_deleted',
      'row is already soft-deleted',
    )
  }
  if (snapshot.retractedAt !== null) {
    throw new SoftDeleteError(
      'already_retracted',
      'row is already retracted; use the retraction path',
    )
  }

  const now = (deps.clock ?? (() => new Date()))()
  await deps.repo.applySoftDelete({
    primitive: args.primitive,
    workspaceId: args.workspaceId,
    rowId: args.rowId,
    actorUserId: args.actorUserId,
    reason: args.reason,
    now,
  })

  return { primitive: args.primitive, rowId: args.rowId, deletedAt: now }
}

export async function hardPurge(
  args: HardPurgeArgs,
  deps: SoftDeleteDeps,
): Promise<HardPurgeResult> {
  if (!isNonEmpty(args.reason)) {
    throw new HardPurgeError(
      'reason_required',
      'reason must be a non-empty string',
    )
  }

  const snapshot = await deps.repo.readForSoftDelete(
    args.primitive,
    args.workspaceId,
    args.rowId,
  )
  if (!snapshot) {
    throw new HardPurgeError(
      'row_not_found',
      `no ${args.primitive} with that id in this workspace`,
    )
  }
  if (snapshot.workspaceId !== args.workspaceId) {
    throw new HardPurgeError(
      'workspace_mismatch',
      'row belongs to a different workspace',
    )
  }

  const now = (deps.clock ?? (() => new Date()))()
  await deps.repo.applyHardPurge({
    primitive: args.primitive,
    workspaceId: args.workspaceId,
    rowId: args.rowId,
    actorUserId: args.actorUserId,
    reason: args.reason,
    ticketReference: args.ticketReference ?? null,
    snapshot,
    now,
  })

  return { primitive: args.primitive, rowId: args.rowId, purgedAt: now }
}

export async function deleteByAuthor(
  args: DeleteByAuthorArgs,
  deps: SoftDeleteDeps,
): Promise<SoftDeleteResult> {
  if (!isNonEmpty(args.reason)) {
    throw new DeleteByAuthorError(
      'reason_required',
      'reason must be a non-empty string',
    )
  }
  if (isPhysicalDeleteOnly(args.primitive)) {
    throw new DeleteByAuthorError(
      'file_physical_delete_only',
      `${args.primitive} cannot be soft-deleted by author; use hardPurge`,
    )
  }

  const snapshot = await deps.repo.readForAuthorshipDelete(
    args.primitive,
    args.workspaceId,
    args.rowId,
  )
  if (!snapshot) {
    throw new DeleteByAuthorError(
      'row_not_found',
      `no ${args.primitive} with that id in this workspace`,
    )
  }
  if (snapshot.workspaceId !== args.workspaceId) {
    throw new DeleteByAuthorError(
      'workspace_mismatch',
      'row belongs to a different workspace',
    )
  }
  if (snapshot.createdByUserId !== args.actorUserId) {
    throw new DeleteByAuthorError(
      'not_author',
      'actor did not author this row',
    )
  }
  if (snapshot.validTo !== null) {
    throw new DeleteByAuthorError(
      'already_soft_deleted',
      'row is already soft-deleted',
    )
  }
  if (snapshot.retractedAt !== null) {
    throw new DeleteByAuthorError(
      'already_retracted',
      'row is already retracted; use the retraction path',
    )
  }

  const now = (deps.clock ?? (() => new Date()))()
  await deps.repo.applySoftDelete({
    primitive: args.primitive,
    workspaceId: args.workspaceId,
    rowId: args.rowId,
    actorUserId: args.actorUserId,
    reason: args.reason,
    now,
  })

  return { primitive: args.primitive, rowId: args.rowId, deletedAt: now }
}
