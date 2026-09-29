/**
 * Frozen normalized extraction plans.
 *
 * A plan is produced only after all model, readiness, classifier, and entity
 * resolution work has finished. It is deliberately provider-free: application
 * and replay consume only these canonical candidates.
 *
 * [COMP:brain/extraction-application]
 */
import { createHash } from 'node:crypto'

export const EXTRACTION_APPLICATION_CONTRACT_VERSION = '1'

export type ExtractionState = 'succeeded' | 'failed' | 'skipped'
export type ApplicationState = 'complete' | 'partial' | 'blocked' | 'not_started'
export type ExtractionItemDisposition =
  | 'pending'
  | 'committed'
  | 'already_applied'
  | 'held'
  | 'rejected'
  | 'failed'

export type ExtractionPrimitiveKind =
  | 'entity'
  | 'edge'
  | 'task'
  | 'memory'
  | 'ephemeral'
  | 'episode_finalization'
  | 'digest_memory'
  | 'digest_edge'

export type FrozenCandidate = {
  candidateId: string
  primitiveKind: ExtractionPrimitiveKind
  payloadHash: string
  dependencyIds: string[]
  payload: Record<string, unknown>
  /** A deliberate no-mutation outcome frozen by planning. */
  terminalDisposition?: 'held' | 'rejected'
  terminalReason?: string
}
export type FrozenExtractionPlan = {
  version: typeof EXTRACTION_APPLICATION_CONTRACT_VERSION
  episodeId: string
  sourceContentHash: string
  sourceScopeVersion: string
  extractorContractVersion: string
  candidates: FrozenCandidate[]
  planHash: string
}

export type DraftExtractionCandidate = {
  /** Plan-local dependency key. It is not persisted after freezing. */
  key: string
  primitiveKind: ExtractionPrimitiveKind
  payload: Record<string, unknown>
  dependencyKeys?: string[]
  terminalDisposition?: 'held' | 'rejected'
  terminalReason?: string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  if (value instanceof Date) return value.toISOString()
  return value
}

export function canonicalExtractionJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function hashExtractionValue(value: unknown): string {
  return createHash('sha256').update(canonicalExtractionJson(value)).digest('hex')
}

export function hashExtractionSource(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function initialExtractionAttemptKey(
  sourceContentHash: string,
  extractorContractVersion: string,
): string {
  return `initial:${hashExtractionValue({ sourceContentHash, extractorContractVersion })}`
}

export function freezeExtractionPlan(input: {
  episodeId: string
  sourceContentHash: string
  sourceScopeVersion: string
  extractorContractVersion: string
  candidates: DraftExtractionCandidate[]
}): FrozenExtractionPlan {
  const keyToId = new Map<string, string>()
  const candidateRows = input.candidates.map((candidate, index) => {
    if (!candidate.key || keyToId.has(candidate.key)) {
      throw new Error('extraction_plan_candidate_key_conflict')
    }
    const payloadHash = hashExtractionValue(candidate.payload)
    const candidateId = `${String(index + 1).padStart(4, '0')}:${candidate.primitiveKind}:${payloadHash.slice(0, 16)}`
    keyToId.set(candidate.key, candidateId)
    return { candidate, candidateId, payloadHash }
  })

  const candidates: FrozenCandidate[] = candidateRows.map(({ candidate, candidateId, payloadHash }) => {
    const dependencyIds = (candidate.dependencyKeys ?? []).map((key) => {
      const id = keyToId.get(key)
      if (!id) throw new Error('extraction_plan_dependency_missing')
      return id
    })
    return {
      candidateId,
      primitiveKind: candidate.primitiveKind,
      payloadHash,
      dependencyIds,
      payload: canonicalize(candidate.payload) as Record<string, unknown>,
      ...(candidate.terminalDisposition
        ? { terminalDisposition: candidate.terminalDisposition }
        : {}),
      ...(candidate.terminalReason ? { terminalReason: candidate.terminalReason } : {}),
    }
  })

  const withoutHash = {
    version: EXTRACTION_APPLICATION_CONTRACT_VERSION,
    episodeId: input.episodeId,
    sourceContentHash: input.sourceContentHash,
    sourceScopeVersion: input.sourceScopeVersion,
    extractorContractVersion: input.extractorContractVersion,
    candidates,
  } as const
  return { ...withoutHash, planHash: hashExtractionValue(withoutHash) }
}
