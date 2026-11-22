/**
 * Provider-free application of one frozen extraction plan.
 *
 * Persistence owns transaction and lease mechanics. This coordinator owns
 * ordering, dependency semantics, and honest run-state derivation.
 *
 * [COMP:brain/extraction-application]
 */
import type {
  ApplicationState,
  ExtractionItemDisposition,
  FrozenCandidate,
  FrozenExtractionPlan,
} from './extraction-plan.js'

export type ExtractionApplicationItem = {
  candidateId: string
  primitiveKind: FrozenCandidate['primitiveKind']
  payloadHash: string
  dependencyIds: string[]
  disposition: ExtractionItemDisposition
  targetRecordId: string | null
  receiptId: string | null
  attemptCount: number
  failureCode: string | null
  retryable: boolean
}

export type ExtractionApplicationCounts = Record<ExtractionItemDisposition, number>

export type ExtractionApplicationRun = {
  id: string
  workspaceId: string
  episodeId: string
  attemptKey: string
  planHash: string
  extractionState: 'succeeded' | 'failed' | 'skipped'
  applicationState: ApplicationState
  errorCode: string | null
  items: ExtractionApplicationItem[]
  counts: ExtractionApplicationCounts
}

export type ExtractionApplicationMutation = {
  disposition?: 'committed' | 'held' | 'rejected'
  targetRecordId?: string | null
  safeCode?: string | null
}

export type ExtractionApplicationClaim = {
  runId: string
  leaseToken: string
  planHash: string
  alreadyComplete?: true
  authority?: {
    actorUserId: string
    workspaceId: string
    mutationCompartments?: string[] | null
    projectIds?: string[] | null
  }
}

export type ExtractionApplicationStorePort = {
  ensureRun(input: {
    workspaceId: string
    episodeId: string
    attemptKey: string
    plan: FrozenExtractionPlan
    extractionState: 'succeeded' | 'failed' | 'skipped'
    outboxJobId?: string | null
  }): Promise<ExtractionApplicationRun>
  claim(
    runId: string,
    expectedPlanHash: string,
    authority?: ExtractionApplicationClaim['authority'],
  ): Promise<ExtractionApplicationClaim>
  /**
   * The concrete store invokes `mutate` inside the same transaction/client as
   * the item receipt. The opaque context must be bound to domain writers by
   * the caller; it must never be reused after this callback returns.
   */
  applyItem(
    claim: ExtractionApplicationClaim,
    candidate: FrozenCandidate,
    mutate: (transactionContext: unknown) => Promise<ExtractionApplicationMutation>,
  ): Promise<ExtractionApplicationItem>
  recordFailure(
    claim: ExtractionApplicationClaim,
    candidateId: string,
    failure: { code: string; retryable: boolean },
  ): Promise<ExtractionApplicationItem>
  finish(claim: ExtractionApplicationClaim): Promise<ExtractionApplicationRun>
  getRun(runId: string): Promise<ExtractionApplicationRun | null>
}

export type ApplyFrozenExtractionPlanArgs = {
  store: ExtractionApplicationStorePort
  workspaceId: string
  attemptKey: string
  plan: FrozenExtractionPlan
  outboxJobId?: string | null
  authority?: ExtractionApplicationClaim['authority']
  mutate: (
    candidate: FrozenCandidate,
    dependencyReceipts: ReadonlyMap<string, ExtractionApplicationItem>,
    transactionContext: unknown,
  ) => Promise<ExtractionApplicationMutation>
}

export class ExtractionApplicationError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'ExtractionApplicationError'
  }
}

export function emptyApplicationCounts(): ExtractionApplicationCounts {
  return {
    pending: 0,
    committed: 0,
    already_applied: 0,
    held: 0,
    rejected: 0,
    failed: 0,
  }
}

function applicationFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ExtractionApplicationError) {
    return { code: error.code.slice(0, 120), retryable: error.retryable }
  }
  const shaped = error as { code?: unknown; retryable?: unknown }
  const code = typeof shaped?.code === 'string' && /^[a-z0-9_:-]{1,120}$/i.test(shaped.code)
    ? shaped.code
    : 'application_write_failed'
  return { code, retryable: shaped?.retryable !== false }
}

export function isRetryableExtractionItem(
  item: Pick<ExtractionApplicationItem, 'disposition' | 'retryable' | 'primitiveKind' | 'failureCode'>,
): boolean {
  return item.disposition === 'pending' || (item.disposition === 'failed' && (item.retryable
    // The old adapter used this code only for an entity alias collision.
    || (item.primitiveKind === 'entity' && item.failureCode === 'application_policy_changed')))
}

export function extractionDependencyState(
  dependencyIds: readonly string[],
  receipts: ReadonlyMap<string, ExtractionApplicationItem>,
): 'ready' | 'pending' | 'blocked' {
  let waiting = false
  for (const id of dependencyIds) {
    const receipt = receipts.get(id)
    if (receipt?.disposition === 'committed' || receipt?.disposition === 'already_applied') continue
    if (!receipt || !isRetryableExtractionItem(receipt)) return 'blocked'
    waiting = true
  }
  return waiting ? 'pending' : 'ready'
}

export async function applyFrozenExtractionPlan(
  args: ApplyFrozenExtractionPlanArgs,
): Promise<ExtractionApplicationRun> {
  let run = await args.store.ensureRun({
    workspaceId: args.workspaceId,
    episodeId: args.plan.episodeId,
    attemptKey: args.attemptKey,
    plan: args.plan,
    extractionState: 'succeeded',
    outboxJobId: args.outboxJobId,
  })
  if (run.planHash !== args.plan.planHash) {
    throw new ExtractionApplicationError('application_plan_conflict')
  }
  if (run.applicationState === 'complete') return run

  const claim = await args.store.claim(run.id, args.plan.planHash, args.authority)
  const currentRun = await args.store.getRun(run.id)
  if (!currentRun) throw new ExtractionApplicationError('application_run_missing')
  if (claim.alreadyComplete) return currentRun
  run = currentRun
  const receipts = new Map(run.items.map((item) => [item.candidateId, item]))

  for (const candidate of args.plan.candidates) {
    const current = receipts.get(candidate.candidateId)
    if (current && !isRetryableExtractionItem(current)) continue

    const dependencyState = extractionDependencyState(candidate.dependencyIds, receipts)
    if (!candidate.terminalDisposition && dependencyState === 'pending') continue

    try {
      const item = await args.store.applyItem(claim, candidate, async (transactionContext) => {
        if (candidate.terminalDisposition) {
          return {
            disposition: candidate.terminalDisposition,
            safeCode: candidate.terminalReason ?? candidate.terminalDisposition,
          }
        }
        if (dependencyState === 'blocked') {
          return { disposition: 'held', safeCode: 'application_dependency_unavailable' }
        }
        return args.mutate(candidate, receipts, transactionContext)
      })
      receipts.set(candidate.candidateId, item)
    } catch (error) {
      const item = await args.store.recordFailure(
        claim,
        candidate.candidateId,
        applicationFailure(error),
      )
      receipts.set(candidate.candidateId, item)
    }
  }

  run = await args.store.finish(claim)
  return run
}
