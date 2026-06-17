/**
 * Ingest PORT — the function-type contracts for the Pipeline B episode ingestors.
 *
 * The impls (`ingest/pipeline-b-processor.ts`) are closed: the ingest pipeline is
 * a closed moat surface (§4). But open callers (chat route, inter-assistant
 * executor, proactive-compaction, brain-mcp) reference these injected-dependency
 * TYPES. So the contracts live here, open; the closed impl imports + re-exports
 * them. See oss-local-brain-wedge.md §12.5.
 */

import type { EpisodeSensitivity } from './db/episodes-store.js'
import type { PipelineBResult } from '@sidanclaw/core'

export type ChatEpisodeInput = {
  workspaceId: string
  userId: string
  assistantId: string
  sessionId: string
  content: string
  occurredAt: Date
  messageIdRange: [string, string]
}

/** Materialize a compacted chat window as an Episode + run Pipeline B. */
export type ChatEpisodeIngestor = (input: ChatEpisodeInput) => Promise<void>

export type BrainEpisodeInput = {
  workspaceId: string
  userId: string
  assistantId: string
  content: string
  occurredAt: Date
  sourceLabel?: string
  sensitivity?: EpisodeSensitivity
}

/** Ingest an arbitrary text Episode (e.g. an MCP `ingestToBrain` call). */
export type BrainEpisodeIngestor = (input: BrainEpisodeInput) => Promise<PipelineBResult>
