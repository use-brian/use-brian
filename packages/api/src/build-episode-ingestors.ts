/**
 * OPEN episode-ingestor factory — the open default for `ports.buildEpisodeIngestors`.
 *
 * Pipeline B (the entity/fact/edge extraction coordinator) lives in OPEN core
 * (`@sidanclaw/core` → `processEpisode`), and every store it needs is built in
 * the open boot graph. The only thing the hosted tier kept closed was the thin
 * WIRING that (a) persists an Episode row and (b) calls `processEpisode` over
 * those stores. This module is the open implementation of exactly that wiring,
 * so the single-player OSS edition runs the same brain distillation locally:
 *
 *   - `brainEpisodeIngestor` — the atomic "ingest one text Episode" primitive
 *     behind the doc-page "Sync to brain" runner, the brain-MCP `ingestToBrain`
 *     tool, and direct file ingest.
 *   - `chatEpisodeIngestor` — materializes a compacted chat window as an Episode
 *     and runs the same pipeline (proactive-compaction → brain).
 *
 * `apps/api/src/index.ts` passes this as `ports.buildEpisodeIngestors`. The
 * hosted platform supplies its own factory over the same `EpisodeIngestorDeps`,
 * so boot is unchanged. See oss-local-brain-wedge.md §12.4 and
 * docs/plans/canvas-brain-distillation.md.
 */

import {
  processEpisode,
  type PipelineBDeps,
  type PipelineBEpisode,
  type Sensitivity,
  type SourceKind,
} from '@sidanclaw/core'
import type { EpisodeIngestorDeps } from './boot.js'
import type { EpisodeSensitivity } from './db/episodes-store.js'
import type { BrainEpisodeIngestor, ChatEpisodeIngestor } from './ingest-port.js'

// Extraction runs on the Standard tier (model-routing.md Trigger #11); the
// optional drift/kind classifier on the Background-Standard lite model.
const EXTRACTION_MODEL = 'gemini-3-flash-standard'
const CLASSIFIER_MODEL = 'gemini-3.1-flash-lite'

/** Generic text ingest (brain-MCP / file) lands as a manual paste; the doc-page
 *  runner overrides this with `'doc_page'` via the input's `sourceKind`. */
const DEFAULT_BRAIN_SOURCE_KIND: SourceKind = 'manual_paste'

/**
 * Reverse of `toEpisodeSensitivity` (episode-sensitivity.ts). The Episode store
 * carries a 4-tier `EpisodeSensitivity`; Pipeline B's `PipelineBEpisode` carries
 * the core 3-tier `Sensitivity`. Both `private` and `secret` collapse to
 * `confidential` (the strictest core tier) so the classifier never widens a
 * stored-sensitive episode.
 */
function toCoreSensitivity(s: EpisodeSensitivity): Sensitivity {
  switch (s) {
    case 'public':
      return 'public'
    case 'internal':
      return 'internal'
    case 'private':
    case 'secret':
      return 'confidential'
  }
}

export function buildEpisodeIngestors(deps: EpisodeIngestorDeps): {
  chatEpisodeIngestor: ChatEpisodeIngestor
  brainEpisodeIngestor: BrainEpisodeIngestor
} {
  // Pipeline B deps are a 1:1 projection of the boot store graph. Built fresh
  // per call so the closure stays stateless (the stores themselves are shared).
  const pipelineDeps = (): PipelineBDeps => ({
    provider: deps.provider,
    model: EXTRACTION_MODEL,
    classifierModel: CLASSIFIER_MODEL,
    crm: deps.crmStore,
    entities: deps.entitiesStore,
    entityLinks: deps.entityLinksStore,
    memories: deps.memoryStore,
    tasks: deps.taskStore,
    episodes: deps.episodesStore,
    analytics: deps.analytics,
  })

  const brainEpisodeIngestor: BrainEpisodeIngestor = async (input) => {
    const sourceKind = input.sourceKind ?? DEFAULT_BRAIN_SOURCE_KIND
    const sensitivity: EpisodeSensitivity = input.sensitivity ?? 'internal'

    // 1. Persist the Episode (status defaults to 'open'); processEpisode drives
    //    the open → extracting → archived lifecycle through the episodes port.
    const episode = await deps.episodesStore.createEpisode(input.userId, {
      sourceKind,
      sourceRef: input.sourceRef ?? { source_kind: sourceKind },
      occurredAt: input.occurredAt,
      workspaceId: input.workspaceId,
      userId: input.userId,
      assistantId: input.assistantId,
      createdByUserId: input.userId,
      createdByAssistantId: input.assistantId,
      sensitivity,
      summaryText: input.sourceLabel ?? null,
    })

    // 2. Run Pipeline B over the persisted episode + resolved content.
    const pbEpisode: PipelineBEpisode = {
      id: episode.id,
      sourceKind,
      occurredAt: input.occurredAt,
      sensitivity: toCoreSensitivity(sensitivity),
      workspaceId: input.workspaceId,
      userId: input.userId,
      assistantId: input.assistantId,
      createdByUserId: input.userId,
      createdByAssistantId: input.assistantId,
    }
    return processEpisode(pbEpisode, input.content, pipelineDeps())
  }

  const chatEpisodeIngestor: ChatEpisodeIngestor = async (input) => {
    // A compacted chat window → one `web_chat` Episode carrying the session +
    // message range as its back-edge, then the same extraction pipeline.
    const episode = await deps.episodesStore.createEpisode(input.userId, {
      sourceKind: 'web_chat',
      sourceRef: {
        source_kind: 'web_chat',
        session_id: input.sessionId,
        message_id_range: input.messageIdRange,
      },
      occurredAt: input.occurredAt,
      workspaceId: input.workspaceId,
      userId: input.userId,
      assistantId: input.assistantId,
      createdByUserId: input.userId,
      createdByAssistantId: input.assistantId,
      sensitivity: 'internal',
    })

    const pbEpisode: PipelineBEpisode = {
      id: episode.id,
      sourceKind: 'web_chat',
      occurredAt: input.occurredAt,
      sensitivity: 'internal',
      workspaceId: input.workspaceId,
      userId: input.userId,
      assistantId: input.assistantId,
      createdByUserId: input.userId,
      createdByAssistantId: input.assistantId,
    }
    await processEpisode(pbEpisode, input.content, pipelineDeps())
  }

  return { chatEpisodeIngestor, brainEpisodeIngestor }
}
