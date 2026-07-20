// [COMP:files/file-ingest-worker] — the file-ingest drain loop
// (large-content-artifacts §Phase 2.2), started in the open boot beside the
// embedding worker and registered on brian-api-workers.
//
// Same start()/stop() + re-entry-guard contract as the recording-process worker.
// Each tick drains the file_ingest_jobs queue back-to-back at concurrency 1
// (one in-memory parse/chunk at a time keeps the workers instance safe). Per job:
//
//   claim -> readBytes (system passthrough) -> parse -> clamp -> indexFileArtifact
//   (chunk into file_segments, idempotent) -> Pipeline B (fact/entity extraction,
//   the episode content_ref pointing at the artifact) -> stamp source_episode_id
//   -> markDone
//
// Everything the loop touches (queue, files read, parse, chunk, Pipeline B) is
// injected so the loop unit-tests without a DB, GCS, or model. Store-only cases
// (audio/video owned by recordings; PDF/image with no `distill` port; empty
// text) short-circuit to markDone without chunking or decomposition — see
// docs/architecture/brain/file-artifacts.md §"Explicitly NOT in v1".

import type { FilesContext, FilesReadBytesResult, FilesResult } from '@use-brian/core'
import { parseFileContent } from '@use-brian/core'
import { getPool } from '../db/client.js'
import type { FileIngestJob } from '../db/file-ingest-jobs-store.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import {
  indexFileArtifact,
  setFileIndexing,
  type IndexFileArtifactResult,
} from './artifact-index.js'

const DEFAULT_INTERVAL_MS = 15_000

/** Worker-side cap on the parsed text a single artifact contributes. Beyond it
 *  the tail is dropped and `metadata.indexing.truncated` records where. */
export const MAX_PARSED_CHARS = 2_000_000

/** Head of the parsed text stored inline on the episode `content_ref` (the same
 *  16 KB budget the closed manual-paste content_ref uses). */
const CONTENT_REF_MAX_CHARS = 16_000

/** Read port the worker needs off `FilesApi` — byte + metadata fetch. */
export type FileIngestReadPort = {
  readBytes: (ctx: FilesContext, idOrPath: string) => Promise<FilesResult<FilesReadBytesResult>>
}

export type FileIngestWorkerDeps = {
  claim: () => Promise<FileIngestJob | null>
  markDone: (id: string) => Promise<void>
  markFailed: (id: string, error: string) => Promise<{ retrying: boolean }>
  /** The workspace FilesApi (BYO-aware); only `readBytes` is used. */
  filesApi: FileIngestReadPort
  /** Parse bytes -> canonical text. Default: `parseFileContent` (@use-brian/core). */
  parse?: (buffer: Buffer, mime: string, fileName: string) => Promise<{ text: string; summary: string }>
  /** Chunk parsed text into file_segments (idempotent). Default: `indexFileArtifact`. */
  index?: (input: {
    fileId: string
    workspaceId: string
    text: string
    actingUserId: string
  }) => Promise<IndexFileArtifactResult>
  /** Stamp `metadata.indexing` (skip / truncation / failure markers). Default: `setFileIndexing`. */
  setIndexing?: (fileId: string, indexing: Record<string, unknown>) => Promise<void>
  /**
   * Pipeline B decomposition port. Absent (open build with no platform ingestor)
   * -> store-only: the artifact is chunked + retrievable but not fact-extracted.
   */
  brainIngest?: BrainEpisodeIngestor
  /** Persist the derived episode id onto `workspace_files.source_episode_id`. */
  stampSourceEpisode?: (fileId: string, workspaceId: string, episodeId: string) => Promise<void>
  /**
   * Distill PDFs/images to text. Absent (v1) -> PDF/image stays store-only (the
   * silent path does not chunk distilled PDFs; explicit /ingest does). See plan
   * §"Explicitly NOT in v1".
   */
  distill?: (input: { buffer: Buffer; mime: string }) => Promise<string>
  intervalMs?: number
}

export type FileIngestWorker = {
  start: () => void
  stop: () => void
  /** Run one drain pass. Exposed for tests + the boot's eager first pass. */
  tick: () => Promise<void>
  isRunning: () => boolean
}

/** Default `stampSourceEpisode` — system-pool UPDATE (no per-user RLS context). */
async function defaultStampSourceEpisode(
  fileId: string,
  workspaceId: string,
  episodeId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE workspace_files SET source_episode_id = $3, updated_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [fileId, workspaceId, episodeId],
  )
}

export function createFileIngestWorker(deps: FileIngestWorkerDeps): FileIngestWorker {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const parse = deps.parse ?? parseFileContent
  const index = deps.index ?? indexFileArtifact
  const setIndexing = deps.setIndexing ?? setFileIndexing
  const stampSourceEpisode = deps.stampSourceEpisode ?? defaultStampSourceEpisode

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function processJob(job: FileIngestJob): Promise<void> {
    // System passthrough read: `clearance` is left undefined (files-api reads any
    // sensitivity for system callers). The job's existence is the authorization —
    // the boundary already ran a membership check before enqueue.
    const ctx: FilesContext = {
      workspaceId: job.workspaceId,
      userId: job.actingUserId,
      assistantId: job.assistantId ?? undefined,
    }
    const read = await deps.filesApi.readBytes(ctx, job.fileId)
    if (!read.ok) {
      throw new Error(`file-ingest: readBytes ${job.fileId} failed (${read.error.kind})`)
    }
    const { file } = read.value
    // readBytes types its payload as Uint8Array; parse/distill want a Buffer.
    const bytes = Buffer.from(read.value.bytes)
    const mime = file.mime
    const fileName = file.name

    // Audio / video are the recording pipeline's domain — never chunk here.
    if (mime.startsWith('audio/') || mime.startsWith('video/')) {
      await setIndexing(job.fileId, {
        status: 'skipped',
        reason: 'media_owned_by_recordings',
        indexedAt: new Date().toISOString(),
      })
      return
    }

    // PDFs / images need model distillation to yield text. Without a `distill`
    // port (v1 silent path) they stay store-only: no chunk, no decomposition.
    const needsDistill = mime === 'application/pdf' || mime.startsWith('image/')
    let text: string
    if (needsDistill) {
      if (!deps.distill) {
        await setIndexing(job.fileId, {
          status: 'skipped',
          reason: 'store_only_needs_distill',
          indexedAt: new Date().toISOString(),
        })
        return
      }
      text = await deps.distill({ buffer: bytes, mime })
    } else {
      const parsed = await parse(bytes, mime, fileName)
      text = parsed.text
    }

    // Worker-side clamp (the chunker independently caps segment count).
    let truncated = false
    if (text.length > MAX_PARSED_CHARS) {
      text = text.slice(0, MAX_PARSED_CHARS)
      truncated = true
    }
    if (text.trim().length === 0) {
      await setIndexing(job.fileId, {
        status: 'skipped',
        reason: 'empty',
        indexedAt: new Date().toISOString(),
      })
      return
    }

    // 1. Chunk into file_segments (idempotent; stamps metadata.indexing 'ready').
    const indexed = await index({
      fileId: job.fileId,
      workspaceId: job.workspaceId,
      text,
      actingUserId: job.actingUserId,
    })
    // Record worker-side (MAX_PARSED_CHARS) truncation over indexFileArtifact's
    // stamp, preserving its segment count so the manifest stays accurate.
    if (truncated) {
      await setIndexing(job.fileId, {
        status: 'ready',
        segments: indexed.segmentCount,
        truncated: true,
        truncatedAtChar: MAX_PARSED_CHARS,
        indexedAt: new Date().toISOString(),
      })
    }

    // 2. Pipeline B decomposition (D5: every promotion is fact/entity extracted,
    //    the episode's content_ref pointing back at the artifact). Requires an
    //    assistant to own the derived episode; the writers always supply one.
    //    Absent ingestor or assistant -> store-only, done.
    if (deps.brainIngest && job.assistantId) {
      const result = await deps.brainIngest({
        workspaceId: job.workspaceId,
        userId: job.actingUserId,
        assistantId: job.assistantId,
        content: text,
        occurredAt: new Date(),
        sourceLabel: job.sourceLabel,
        sensitivity: 'internal',
        sourceKind: 'file_upload',
        sourceRef: { file_id: job.fileId, path: file.path },
        contentRef: {
          source_kind: 'file_upload',
          file_id: job.fileId,
          text: text.slice(0, CONTENT_REF_MAX_CHARS),
        },
      })
      if (result?.episodeId) {
        await stampSourceEpisode(job.fileId, job.workspaceId, result.episodeId)
      }
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      // Drain back-to-back while jobs are available (concurrency 1).
      for (;;) {
        const job = await deps.claim()
        if (!job) break
        try {
          await processJob(job)
          await deps.markDone(job.id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await deps.markFailed(job.id, msg).catch(() => ({ retrying: false }))
          await setIndexing(job.fileId, {
            status: 'failed',
            error: msg.slice(0, 2000),
            failedAt: new Date().toISOString(),
          }).catch(() => {})
          console.error(`[file-ingest-worker] job ${job.id} failed: ${msg}`)
        }
      }
    } catch (err) {
      // Claim-side failure (DB blip). Log and let the next tick retry.
      console.error('[file-ingest-worker] tick error:', err)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    tick,
    isRunning: () => running,
  }
}
