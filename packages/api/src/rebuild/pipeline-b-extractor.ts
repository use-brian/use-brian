/**
 * Pipeline B shadow extractor — the production `RebuildExtractor`.
 *
 * Re-runs the SAME extraction that derived the brain the first time
 * (`processEpisode`), against a deps override whose memory writes land in
 * the `memories_shadow` namespace stamped with the run + target pipeline
 * version. Every other dep (entities, CRM, episodes, classifier) is the
 * caller's production wiring, unchanged — the shadow boundary is exactly
 * the memory-create seam, because memories are the v1 rebuild primitive
 * (entities/knowledge trail per the plan's deferred-coverage note; their
 * writes during a shadow run are suppressed to no-ops below so a rebuild
 * cannot double-write the live graph).
 *
 * Spec: docs/architecture/brain/retroactive-rebuild.md
 * [COMP:api/rebuild-flow]
 */

import { randomUUID } from 'node:crypto'
import { processEpisode, type PipelineBDeps, type PipelineBEpisode } from '@use-brian/core'
import { createMemory } from '../db/memories.js'
import type { RebuildEpisodeRef, RebuildExtractor } from './rebuild.js'

export function createPipelineBExtractor(args: {
  deps: PipelineBDeps
  /** Resolve an episode's full content the way the batch processor does. */
  resolveContent: (episodeId: string) => Promise<string | null>
  /** Load the full PipelineBEpisode row for processEpisode. */
  loadEpisode: (episodeId: string) => Promise<PipelineBEpisode | null>
}): RebuildExtractor {
  return async (ref: RebuildEpisodeRef, run) => {
    const episode = await args.loadEpisode(ref.id)
    if (!episode) return { written: 0 }
    const content = await args.resolveContent(ref.id)
    if (!content || content.trim().length === 0) return { written: 0 }

    let written = 0
    const shadowDeps: PipelineBDeps = {
      ...args.deps,
      memories: {
        ...args.deps.memories,
        create: async (params) => {
          const m = await createMemory({
            ...params,
            createdByAssistantId: params.createdByAssistantId ?? undefined,
            sourceEpisodeId: params.sourceEpisodeId ?? ref.id,
            shadow: {
              rebuildRunId: run.id,
              pipelineVersion: run.targetPipelineVersion,
            },
          })
          written += 1
          return {
            id: m.id,
            scope: m.scope,
            summary: m.summary,
            detail: m.detail,
            tags: m.tags,
            confidence: m.confidence,
            sensitivity: m.sensitivity,
            compartments: m.compartments,
            projectIds: m.projectIds,
            workspaceId: m.workspaceId,
          }
        },
      },
      // A shadow derivation must not mutate the live graph, CRM, or
      // tasks: the v1 rebuild diffs and promotes MEMORIES only. Every
      // side-writer Pipeline B calls (entities.create/addAlias,
      // entityLinks.create, crm.createContact/createCompany,
      // tasks/taskAdmission) is stubbed to a shape-minimal fake so the
      // extraction still runs end to end - a minted id keeps downstream
      // references working, and nothing lands outside memories_shadow.
      // The mentioned-edge hook is already skipped by the shadow create
      // at the db layer.
      entities: {
        ...args.deps.entities,
        create: (async (params: Record<string, unknown>) => ({
          ...params,
          id: randomUUID(),
        })) as unknown as PipelineBDeps['entities']['create'],
        addAlias: (async () => {}) as unknown as PipelineBDeps['entities']['addAlias'],
      },
      entityLinks: {
        ...args.deps.entityLinks,
        create: (async (params: Record<string, unknown>) => ({
          ...params,
          id: randomUUID(),
        })) as unknown as PipelineBDeps['entityLinks']['create'],
      },
      crm: {
        ...args.deps.crm,
        createContact: (async (params: Record<string, unknown>) => ({
          ...params,
          id: randomUUID(),
        })) as unknown as PipelineBDeps['crm']['createContact'],
        createCompany: (async (params: Record<string, unknown>) => ({
          ...params,
          id: randomUUID(),
        })) as unknown as PipelineBDeps['crm']['createCompany'],
      },
      // Optional lanes: absent means Pipeline B drops task items with a
      // warn - correct for a memory-only shadow run.
      tasks: undefined,
      taskAdmission: undefined,
      // Episode archival state belongs to the LIVE pipeline; a shadow
      // re-derivation must not restamp it.
      episodes: {
        ...args.deps.episodes,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        markExtracted: (async () => {}) as any,
      } as PipelineBDeps['episodes'],
    }

    await processEpisode(episode, content, shadowDeps)
    return { written }
  }
}
