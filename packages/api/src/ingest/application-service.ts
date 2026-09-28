/**
 * Shared authorized recovery service for HTTP, Studio, and first-party tools.
 *
 * [COMP:api/ingest-application]
 */
import {
  applyFrozenExtractionPlan,
  ExtractionApplicationError,
  type AccessContext,
  type ExtractionApplicationItem,
  type ExtractionApplicationMutation,
  type ExtractionApplicationRun,
  type FrozenCandidate,
  type FrozenExtractionPlan,
} from '@use-brian/core'

import type { DbEpisodesStore } from '../db/episodes-store.js'
import type {
  AuthorizedApplicationPage,
  DbExtractionApplicationStore,
} from '../db/extraction-application-store.js'

export type IngestApplicationItemProjection = Pick<
  ExtractionApplicationItem,
  'candidateId' | 'primitiveKind' | 'disposition' | 'attemptCount' | 'failureCode' | 'retryable'
>

export type IngestApplicationProjection = {
  status: 'tracked'
  runId: string
  episodeId: string
  planHash: string
  extractionState: ExtractionApplicationRun['extractionState']
  applicationState: ExtractionApplicationRun['applicationState']
  errorCode: string | null
  counts: ExtractionApplicationRun['counts']
  resumable: boolean
  items: IngestApplicationItemProjection[]
}

export type LegacyUntrackedApplication = {
  status: 'legacy_untracked'
  episodeId: string
  resumable: false
}

export type IngestApplicationStatus = IngestApplicationProjection | LegacyUntrackedApplication

export class IngestApplicationServiceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'forbidden' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'IngestApplicationServiceError'
  }
}

export type ExtractionCandidateMutationPort = (input: {
  candidate: FrozenCandidate
  dependencies: ReadonlyMap<string, ExtractionApplicationItem>
  transactionContext: unknown
  plan: FrozenExtractionPlan
}) => Promise<ExtractionApplicationMutation>

export type IngestApplicationService = ReturnType<typeof createIngestApplicationService>

function projection(run: ExtractionApplicationRun): IngestApplicationProjection {
  return {
    status: 'tracked',
    runId: run.id,
    episodeId: run.episodeId,
    planHash: run.planHash,
    extractionState: run.extractionState,
    applicationState: run.applicationState,
    errorCode: run.errorCode,
    counts: run.counts,
    resumable: run.applicationState !== 'complete'
      && run.items.some((item) => item.disposition === 'pending'
        || (item.disposition === 'failed' && item.retryable)),
    items: run.items.map((item) => ({
      candidateId: item.candidateId,
      primitiveKind: item.primitiveKind,
      disposition: item.disposition,
      attemptCount: item.attemptCount,
      failureCode: item.failureCode,
      retryable: item.retryable,
    })),
  }
}

function translate(error: unknown): never {
  if (error instanceof IngestApplicationServiceError) throw error
  if (error instanceof ExtractionApplicationError) {
    if (['application_source_missing', 'application_run_missing', 'application_item_missing'].includes(error.code)) {
      throw new IngestApplicationServiceError('not_found', 'Ingestion application not found')
    }
    if (['application_authority_denied', 'application_authority_missing', 'application_source_blocked'].includes(error.code)) {
      throw new IngestApplicationServiceError('forbidden', 'Current authority cannot apply this extraction')
    }
    throw new IngestApplicationServiceError('conflict', 'The frozen application can no longer be resumed safely')
  }
  throw error
}

export function createIngestApplicationService(options: {
  store: DbExtractionApplicationStore
  episodes: DbEpisodesStore
  mutateCandidate: ExtractionCandidateMutationPort
  getWorkspaceRole: (userId: string, workspaceId: string) => Promise<'owner' | 'admin' | 'member' | null>
}) {
  const apply = async (input: {
    workspaceId: string
    actorUserId: string
    mutationCompartments: string[] | null
    projectIds: string[] | null
    attemptKey: string
    plan: FrozenExtractionPlan
    outboxJobId?: string | null
  }): Promise<ExtractionApplicationRun> => {
    try {
      return await applyFrozenExtractionPlan({
        store: options.store,
        workspaceId: input.workspaceId,
        attemptKey: input.attemptKey,
        plan: input.plan,
        outboxJobId: input.outboxJobId,
        authority: {
          actorUserId: input.actorUserId,
          workspaceId: input.workspaceId,
          mutationCompartments: input.mutationCompartments,
          projectIds: input.projectIds,
        },
        mutate: (candidate, dependencies, transactionContext) =>
          options.mutateCandidate({ candidate, dependencies, transactionContext, plan: input.plan }),
      })
    } catch (error) {
      return translate(error)
    }
  }

  return {
    apply,

    async get(ctx: AccessContext, episodeId: string): Promise<IngestApplicationStatus> {
      const source = await options.episodes.getEpisodeById(ctx, episodeId)
      if (!source) throw new IngestApplicationServiceError('not_found', 'Episode not found')
      const run = await options.store.getAuthorized(ctx, episodeId)
      return run ? projection(run) : { status: 'legacy_untracked', episodeId, resumable: false }
    },

    async list(ctx: AccessContext, opts?: { cursor?: string; limit?: number }): Promise<{
      applications: IngestApplicationProjection[]
      nextCursor: string | null
    }> {
      const page: AuthorizedApplicationPage = await options.store.listAuthorized(ctx, opts)
      return { applications: page.runs.map(projection), nextCursor: page.nextCursor }
    },

    async retry(input: {
      ctx: AccessContext
      episodeId: string
      runId: string
      expectedPlanHash: string
    }): Promise<IngestApplicationProjection> {
      try {
        const role = await options.getWorkspaceRole(input.ctx.userId, input.ctx.workspaceId)
        if (role !== 'owner' && role !== 'admin') {
          throw new IngestApplicationServiceError('forbidden', 'Owner or administrator recovery is required')
        }
        if (input.ctx.mutationCompartments === undefined || input.ctx.projectIds === undefined) {
          throw new IngestApplicationServiceError('forbidden', 'Verified mutation authority is required')
        }
        const visible = await options.store.getAuthorized(
          input.ctx,
          input.episodeId,
          input.runId,
          'mutation',
        )
        if (!visible) throw new IngestApplicationServiceError('not_found', 'Episode application not found')
        if (visible.planHash !== input.expectedPlanHash || visible.applicationState === 'complete') {
          throw new IngestApplicationServiceError('conflict', 'The application plan is stale or not resumable')
        }
        const plan = await options.store.getFrozenPlan(input.runId)
        if (!plan || plan.planHash !== input.expectedPlanHash || plan.episodeId !== input.episodeId) {
          throw new IngestApplicationServiceError('conflict', 'The application plan is stale or unavailable')
        }
        const run = await apply({
          workspaceId: input.ctx.workspaceId,
          actorUserId: input.ctx.userId,
          mutationCompartments: input.ctx.mutationCompartments ?? null,
          projectIds: input.ctx.projectIds ?? null,
          attemptKey: visible.attemptKey,
          plan,
        })
        return projection(run)
      } catch (error) {
        return translate(error)
      }
    },
  }
}
