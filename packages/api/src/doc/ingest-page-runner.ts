/**
 * Doc-page → brain ingest RUNNER (the API-side wiring of the core
 * `distillPageToBrain`). Loads a page, builds the real ports (Pipeline B via
 * the brain episode ingestor + the `kb_chunks` page-source upsert), runs the
 * pure core distillation, and stamps the result on `saved_views`
 * (`brain_last_ingest_hash` / `_at`).
 *
 * Three entry paths share this runner:
 *   - the manual `POST /api/saved-views/:id/ingest` route (RLS-checked),
 *   - the `ingestPage` chat tool (assistant on request),
 *   - the auto-on-save trigger (`POST /internal/ingest-page` from doc-sync,
 *     gated by the per-page toggle + the content-hash/cooldown guard).
 *
 * All three run the runner in the BACKGROUND (the routes return immediately;
 * errors are logged, never surfaced to the save/response path) — Pipeline B is
 * async by design (canvas-brain-distillation.md §"The ingestion pipeline":
 * "enqueue a job — never runs Pipeline B inline").
 *
 * RLS scope: reads go through the RLS-scoped page read (`getVersionedPage`
 * /`getById` with the page owner's userId), so the runner only ever distils a
 * page the resolved owner can see. The `/internal/ingest-page` endpoint resolves
 * the owner (`getBrainSyncStateSystem` → `created_by`) before calling here.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md.
 *
 * [COMP:api/doc-ingest-page-runner]
 */

import {
  distillPageToBrain,
  type DistillPageResult,
  type PageSourceChunk,
  type RunSectionEpisode,
  type SavedViewStore,
  type UpsertPageSource,
} from '@use-brian/core'
import type { DocPageStore } from '@use-brian/core'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import type { EpisodeSensitivity } from '../db/episodes-store.js'
import type { DocPageSourceStore } from '../db/doc-page-source-store.js'

/** Page clearance → Episode sensitivity (the 4-value episode tier). */
function episodeSensitivityFromClearance(
  clearance: 'public' | 'internal' | 'confidential',
): EpisodeSensitivity {
  return clearance === 'confidential' ? 'private' : clearance
}

export type IngestPageDeps = {
  savedViewStore: SavedViewStore
  docPageStore: DocPageStore
  docPageSourceStore: DocPageSourceStore
  /** The closed Pipeline B brain ingestor; absent in minimal/open builds. */
  brainEpisodeIngestor?: BrainEpisodeIngestor
  /** Resolve the workspace's primary assistant — the Episode's `assistant_id`. */
  resolvePrimaryAssistant: (workspaceId: string) => Promise<string | null>
}

export type IngestPageArgs = {
  /** The page owner (or an authorised member) the read is RLS-scoped to. */
  userId: string
  pageId: string
  /**
   * When set and it matches the page's current authored hash, distillation is
   * skipped. The auto-on-save path passes `brain_last_ingest_hash` here so an
   * unchanged page short-circuits even past the doc-sync-side guard.
   */
  skipIfHashUnchanged?: string | null
}

export type IngestPageOutcome =
  | { ok: true; result: DistillPageResult }
  | { ok: false; reason: 'page_not_found' | 'ingestor_unavailable' | 'error'; message?: string }

/**
 * Run the doc-page distillation once. Returns an outcome (never throws on the
 * happy/expected paths); the route wrappers `void`-call this in the background.
 */
export async function runIngestPage(
  args: IngestPageArgs,
  deps: IngestPageDeps,
): Promise<IngestPageOutcome> {
  if (!deps.brainEpisodeIngestor) {
    console.warn(`[ingest-page] ${args.pageId}: skipped — brain episode ingestor not wired (no Pipeline B)`)
    return { ok: false, reason: 'ingestor_unavailable' }
  }

  // RLS-scoped read of the page metadata (workspace, owner, clearance, version)
  // + the live merged page blocks (prefers the Yjs snapshot via getVersionedPage).
  const view = await deps.savedViewStore.getById(args.userId, args.pageId)
  if (!view) {
    console.warn(`[ingest-page] ${args.pageId}: skipped — page not found for user ${args.userId}`)
    return { ok: false, reason: 'page_not_found' }
  }
  const read = await deps.docPageStore.getVersionedPage(args.userId, args.pageId)
  if (!read) {
    console.warn(`[ingest-page] ${args.pageId}: skipped — versioned page body not found`)
    return { ok: false, reason: 'page_not_found' }
  }

  const assistantId = await deps.resolvePrimaryAssistant(view.workspaceId)
  if (!assistantId) {
    console.warn(
      `[ingest-page] ${args.pageId}: skipped — no primary assistant in workspace ${view.workspaceId}`,
    )
    return { ok: false, reason: 'ingestor_unavailable' }
  }
  console.log(`[ingest-page] ${args.pageId}: distilling to brain (workspace ${view.workspaceId})`)

  const ingestor = deps.brainEpisodeIngestor
  const episodeSensitivity = episodeSensitivityFromClearance(view.clearance)
  const occurredAt = new Date()

  // Port 1 — the "processEpisode runner": one `doc_page` Episode per section,
  // carrying the `(page_id, section_block_id, version)` back-edge so Pipeline B's
  // derived facts point at the exact block. Reuses Pipeline B UNMODIFIED via the
  // closed brain ingestor.
  const runSectionEpisode: RunSectionEpisode = async ({ content, backEdge }) => {
    const result = await ingestor({
      workspaceId: view.workspaceId,
      userId: args.userId,
      assistantId,
      content,
      occurredAt,
      sourceLabel: `doc page ${view.name}`,
      sensitivity: episodeSensitivity,
      sourceKind: 'doc_page',
      sourceRef: {
        source_kind: 'doc_page',
        page_id: backEdge.pageId,
        section_block_id: backEdge.sectionBlockId,
        version: backEdge.version,
      },
    })
    return { episodeId: result.episodeId ?? null }
  }

  // Port 2 — page-as-source: upsert the authored blocks into the `kb_chunks`
  // shape (keyed by page + block). The page-level clearance maps straight to the
  // chunk sensitivity (kb_chunks.sensitivity is free text — the three clearance
  // values are valid).
  const upsertPageSource: UpsertPageSource = async ({ pageId, chunks }) => {
    await deps.docPageSourceStore.upsertPageChunks({
      pageId,
      workspaceId: view.workspaceId,
      ownerUserId: view.createdBy,
      sensitivity: view.clearance,
      chunks: chunks.map(
        (c): PageSourceChunk => c, // structural — DocPageSourceChunk == PageSourceChunk shape
      ),
    })
  }

  try {
    const result = await distillPageToBrain(
      {
        pageId: args.pageId,
        version: read.version,
        page: read.page,
        skipIfHashUnchanged: args.skipIfHashUnchanged ?? null,
      },
      { runSectionEpisode, upsertPageSource },
    )

    if (result.ingested) {
      // Stamp the dedup/cooldown anchors so the next save can short-circuit.
      await deps.savedViewStore.markBrainIngestedSystem(args.pageId, result.contentHash)
      console.log(
        `[ingest-page] ${args.pageId}: ingested ${result.sectionsProcessed} section(s), ${result.chunksUpserted} chunk(s) → brain (hash ${result.contentHash.slice(0, 8)})`,
      )
    } else {
      console.log(`[ingest-page] ${args.pageId}: no-op — authored content unchanged since last ingest`)
    }
    return { ok: true, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[ingest-page] distillation failed for page ${args.pageId}: ${message}`)
    return { ok: false, reason: 'error', message }
  }
}
