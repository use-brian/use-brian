/**
 * D-locks D.3 (memory retraction + hard purge + re-extraction guard) and
 * D.5 (operator-only `reExtractEpisode`). Spec:
 * docs/architecture/brain/corrections.md §D.3, §D.5.
 *
 * Pure orchestration module. All persistence is delegated to injected
 * `MemoryRetractionRepository` + `EpisodeReExtractionRepository` ports.
 * No DB driver, no SQL, no I/O in this file. The DB adapter that
 * fulfils these ports lives in the API package (separate work unit).
 *
 * Distinctions enforced here:
 *
 *  • `retracted_at` means "was never correct" — set by `retractMemory`.
 *    Pipeline B's re-extraction guard (`findRetractedMatch`) must check
 *    this before re-deriving a fact, else corrections silently regress.
 *
 *  • `valid_to` alone (no `retracted_at`) means "was true at the time,
 *    then changed." `reExtractEpisode` supersedes derivations this way
 *    — they were valid extractions, just outdated. New derivations
 *    written by the extraction worker still respect prior retractions.
 *
 * Out of scope (enforced elsewhere):
 *
 *  • Confirmation flow scaling (single-tap vs reason-required vs
 *    type-to-confirm per D.8) is at the tool layer. This module only
 *    enforces that `reason` is a non-empty string.
 *
 *  • Consolidation interaction (Light skip / REM exclude / Deep score
 *    0 for retracted rows per D.3 §Consolidation interaction) is in
 *    `consolidation/phases.ts` via `valid_to` + `retracted_at` filters.
 *    No code needed here.
 *
 *  • Permission tiers (member vs admin vs operator + ticket per D.8)
 *    are at the tool layer. `reExtractEpisode` requires a non-empty
 *    `ticketReference` but does not validate it.
 */

// ── Snapshots & args ────────────────────────────────────────────────

export interface MemoryRetractionSnapshot {
  id: string
  workspaceId: string
  retractedAt: Date | null
  validTo: Date | null
  sourceEpisodeId: string | null
  semanticHash: string | null
  createdByUserId: string | null
}

export interface RetractMemoryArgs {
  workspaceId: string
  memoryId: string
  actorUserId: string
  reason: string
}

export interface PurgeMemoryArgs {
  workspaceId: string
  memoryId: string
  actorUserId: string
  reason: string
}

export interface FindRetractedMatchArgs {
  workspaceId: string
  sourceEpisodeId: string
  semanticHash: string
}

export interface ReExtractEpisodeArgs {
  workspaceId: string
  episodeId: string
  operatorUserId: string
  ticketReference: string
  reason: string
}

// ── Results ─────────────────────────────────────────────────────────

export interface MemoryRetractionResult {
  memoryId: string
  retractedAt: Date
}

export interface MemoryPurgeResult {
  memoryId: string
  purgedAt: Date
}

export interface ReExtractEpisodeResult {
  episodeId: string
  derivationsSuperseded: number
  extractionTriggered: boolean
}

/**
 * One supersession candidate from a re-extraction snapshot. The
 * `primitive` discriminator covers extraction-derived rows. Note that
 * `'entity_link'` is included defensively — edge re-extraction is
 * blocked until `entity_links` carries the universal column set.
 */
export interface EpisodeDerivationSnapshot {
  primitive: 'memory' | 'task' | 'entity_link' | 'entity'
  rowId: string
  validTo: Date | null
}

// ── Failure model ───────────────────────────────────────────────────

export type RetractionFailureCode =
  | 'memory_not_found'
  | 'memory_already_retracted'
  | 'workspace_mismatch'
  | 'reason_required'

export type PurgeFailureCode =
  | 'memory_not_found'
  | 'workspace_mismatch'
  | 'reason_required'

export type ReExtractFailureCode =
  | 'episode_not_found'
  | 'workspace_mismatch'
  | 'ticket_required'
  | 'reason_required'
  | 'extraction_trigger_failed'

export class MemoryRetractionError extends Error {
  readonly code: RetractionFailureCode
  constructor(code: RetractionFailureCode, message: string) {
    super(message)
    this.name = 'MemoryRetractionError'
    this.code = code
  }
}

export class MemoryPurgeError extends Error {
  readonly code: PurgeFailureCode
  constructor(code: PurgeFailureCode, message: string) {
    super(message)
    this.name = 'MemoryPurgeError'
    this.code = code
  }
}

export class EpisodeReExtractionError extends Error {
  readonly code: ReExtractFailureCode
  constructor(code: ReExtractFailureCode, message: string) {
    super(message)
    this.name = 'EpisodeReExtractionError'
    this.code = code
  }
}

// ── Ports (implemented by the DB adapter, not by this module) ───────

export interface ApplySoftRetractInput {
  workspaceId: string
  memoryId: string
  retractedBy: string
  reason: string
  now: Date
}

export interface ApplyHardPurgeInput {
  workspaceId: string
  memoryId: string
  actorUserId: string
  reason: string
  snapshot: MemoryRetractionSnapshot
  now: Date
}

export interface MemoryRetractionRepository {
  readMemoryForRetraction(
    workspaceId: string,
    memoryId: string,
  ): Promise<MemoryRetractionSnapshot | null>

  applySoftRetract(input: ApplySoftRetractInput): Promise<void>

  applyHardPurge(input: ApplyHardPurgeInput): Promise<void>

  findRetractedMatch(
    args: FindRetractedMatchArgs,
  ): Promise<MemoryRetractionSnapshot | null>
}

export interface SupersedeDerivationsInput {
  workspaceId: string
  episodeId: string
  derivations: readonly EpisodeDerivationSnapshot[]
  operatorUserId: string
  ticketReference: string
  reason: string
  now: Date
}

export interface TriggerExtractionInput {
  workspaceId: string
  episodeId: string
  operatorUserId: string
}

export interface EpisodeReExtractionRepository {
  readEpisodeForReExtraction(
    workspaceId: string,
    episodeId: string,
  ): Promise<{ id: string; workspaceId: string } | null>

  snapshotDerivations(
    workspaceId: string,
    episodeId: string,
  ): Promise<readonly EpisodeDerivationSnapshot[]>

  supersedeDerivations(
    input: SupersedeDerivationsInput,
  ): Promise<{ supersededCount: number }>

  triggerExtraction(input: TriggerExtractionInput): Promise<void>
}

export interface RetractionDeps {
  memoryRepo: MemoryRetractionRepository
  episodeRepo?: EpisodeReExtractionRepository
  clock?: () => Date
}

// ── Guards (pure) ───────────────────────────────────────────────────

function isNonEmpty(s: string | undefined | null): s is string {
  return typeof s === 'string' && s.trim().length > 0
}

// ── Orchestration ───────────────────────────────────────────────────

export async function retractMemory(
  args: RetractMemoryArgs,
  deps: RetractionDeps,
): Promise<MemoryRetractionResult> {
  if (!isNonEmpty(args.reason)) {
    throw new MemoryRetractionError(
      'reason_required',
      'reason must be a non-empty string',
    )
  }

  const snapshot = await deps.memoryRepo.readMemoryForRetraction(
    args.workspaceId,
    args.memoryId,
  )
  if (!snapshot) {
    throw new MemoryRetractionError(
      'memory_not_found',
      'no memory with that id in this workspace',
    )
  }
  if (snapshot.workspaceId !== args.workspaceId) {
    throw new MemoryRetractionError(
      'workspace_mismatch',
      'memory belongs to a different workspace',
    )
  }
  if (snapshot.retractedAt !== null) {
    throw new MemoryRetractionError(
      'memory_already_retracted',
      'memory is already retracted',
    )
  }

  const now = (deps.clock ?? (() => new Date()))()
  await deps.memoryRepo.applySoftRetract({
    workspaceId: args.workspaceId,
    memoryId: args.memoryId,
    retractedBy: args.actorUserId,
    reason: args.reason,
    now,
  })

  return { memoryId: args.memoryId, retractedAt: now }
}

export async function purgeMemory(
  args: PurgeMemoryArgs,
  deps: RetractionDeps,
): Promise<MemoryPurgeResult> {
  if (!isNonEmpty(args.reason)) {
    throw new MemoryPurgeError(
      'reason_required',
      'reason must be a non-empty string',
    )
  }

  const snapshot = await deps.memoryRepo.readMemoryForRetraction(
    args.workspaceId,
    args.memoryId,
  )
  if (!snapshot) {
    throw new MemoryPurgeError(
      'memory_not_found',
      'no memory with that id in this workspace',
    )
  }
  if (snapshot.workspaceId !== args.workspaceId) {
    throw new MemoryPurgeError(
      'workspace_mismatch',
      'memory belongs to a different workspace',
    )
  }

  const now = (deps.clock ?? (() => new Date()))()
  await deps.memoryRepo.applyHardPurge({
    workspaceId: args.workspaceId,
    memoryId: args.memoryId,
    actorUserId: args.actorUserId,
    reason: args.reason,
    snapshot,
    now,
  })

  return { memoryId: args.memoryId, purgedAt: now }
}

/**
 * Thin pass-through helper. Exposed so Pipeline B can guard
 * re-extraction without importing the module-internal port. Returning
 * null means the candidate is safe to write; a non-null result means
 * the extraction must be suppressed per D.3 §Re-extraction protection.
 */
export async function findRetractedMatch(
  args: FindRetractedMatchArgs,
  deps: RetractionDeps,
): Promise<MemoryRetractionSnapshot | null> {
  return deps.memoryRepo.findRetractedMatch(args)
}

export async function reExtractEpisode(
  args: ReExtractEpisodeArgs,
  deps: RetractionDeps,
): Promise<ReExtractEpisodeResult> {
  if (!deps.episodeRepo) {
    throw new EpisodeReExtractionError(
      'extraction_trigger_failed',
      'episodeRepo is required for reExtractEpisode',
    )
  }
  if (!isNonEmpty(args.ticketReference)) {
    throw new EpisodeReExtractionError(
      'ticket_required',
      'ticketReference must be a non-empty string',
    )
  }
  if (!isNonEmpty(args.reason)) {
    throw new EpisodeReExtractionError(
      'reason_required',
      'reason must be a non-empty string',
    )
  }

  const episode = await deps.episodeRepo.readEpisodeForReExtraction(
    args.workspaceId,
    args.episodeId,
  )
  if (!episode) {
    throw new EpisodeReExtractionError(
      'episode_not_found',
      'no episode with that id in this workspace',
    )
  }
  if (episode.workspaceId !== args.workspaceId) {
    throw new EpisodeReExtractionError(
      'workspace_mismatch',
      'episode belongs to a different workspace',
    )
  }

  const now = (deps.clock ?? (() => new Date()))()
  const derivations = await deps.episodeRepo.snapshotDerivations(
    args.workspaceId,
    args.episodeId,
  )

  const { supersededCount } = await deps.episodeRepo.supersedeDerivations({
    workspaceId: args.workspaceId,
    episodeId: args.episodeId,
    derivations,
    operatorUserId: args.operatorUserId,
    ticketReference: args.ticketReference,
    reason: args.reason,
    now,
  })

  try {
    await deps.episodeRepo.triggerExtraction({
      workspaceId: args.workspaceId,
      episodeId: args.episodeId,
      operatorUserId: args.operatorUserId,
    })
  } catch (err) {
    throw new EpisodeReExtractionError(
      'extraction_trigger_failed',
      err instanceof Error ? err.message : 'extraction worker enqueue failed',
    )
  }

  return {
    episodeId: args.episodeId,
    derivationsSuperseded: supersededCount,
    extractionTriggered: true,
  }
}
