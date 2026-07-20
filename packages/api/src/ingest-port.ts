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
import type { PipelineBResult, SourceKind } from '@use-brian/core'

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
  /**
   * Override the Episode's `source_kind` (default the closed impl uses for a
   * generic text ingest). Doc-page distillation passes `'doc_page'` so the
   * derived facts carry doc-page provenance. The closed Pipeline B impl stamps
   * this onto the Episode and Pipeline B inherits the general trust model like
   * any source. See docs/architecture/brain/ingest-pipeline.md §"New vs. reused".
   */
  sourceKind?: SourceKind
  /**
   * The Episode's `source_ref` payload (JSONB). Doc-page distillation passes
   * `{ source_kind:'doc_page', page_id, section_block_id, version }` so every
   * fact gets a precise `(page_id, block_id)` back-edge via `source_episode_id`.
   * Omitted for the generic text ingest path (the closed impl supplies a
   * default ref). The closed impl persists it verbatim.
   */
  sourceRef?: Record<string, unknown>
  /**
   * The Episode's `content_ref` payload (JSONB). File-upload ingest passes
   * `{ source_kind:'file_upload', file_id, text: <head> }` so the fact→passage
   * escalation seam (D5, large-content-artifacts.md) knows the derived facts
   * point at a stored artifact. Omitted for the generic text ingest path (the
   * ingestor falls back to a `manual_paste` inline ref). Persisted verbatim.
   */
  contentRef?: Record<string, unknown>
  /**
   * The anchor Episode this ingest derives from (`episodes.parent_episode_id`).
   * The recording path passes the recording Episode's id, so the derived
   * `voice_memo` Episode — and through it every extracted memory, entity, and
   * task — keeps a native FK back to the audio. `sourceRef` carries the same
   * edge as JSONB for callers that read provenance; this is the queryable half
   * (`EpisodeFilters.parentEpisodeId`). Omitted for standalone ingests.
   */
  parentEpisodeId?: string
}

/** Ingest an arbitrary text Episode (e.g. an MCP `ingestToBrain` call). */
export type BrainEpisodeIngestor = (input: BrainEpisodeInput) => Promise<PipelineBResult>
