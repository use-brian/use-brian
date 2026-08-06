/**
 * createFileIngestor - the shared "drop a file into the brain" routine.
 *
 * One file:
 *   1. stores the original bytes in workspace_files,
 *   2. when `process !== false`, derives text locally or through an injected
 *      PDF/image distiller,
 *   3. indexes segments and decomposes the text through Pipeline B.
 *
 * Every outcome that is NOT "stored, indexed and decomposed in full" reports
 * why: a `skipped` reason when the file was stored but not interpreted, and
 * `truncated` when the segment cap stopped chunking before the tail. The
 * result type is the only place a caller can learn either, so a field left off
 * here is a loss the user never hears about.
 *
 * [COMP:files/ingest]
 */

import {
  parseFileContent,
  type FilesApi,
  type FilesContext,
  type FileSensitivity,
} from '@use-brian/core'
import { toEpisodeSensitivity } from '../episode-sensitivity.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import { indexFileArtifact, setFileIndexing } from './artifact-index.js'
import { FileIngestError } from './ingest-error.js'
import type {
  FileIngestContext,
  FileIngestCounts,
  FileIngestInput,
  FileIngestor,
  FileIngestResult,
} from './ingest-port.js'

export type {
  FileIngestContext,
  FileIngestCounts,
  FileIngestInput,
  FileIngestor,
  FileIngestResult,
} from './ingest-port.js'
export { FileIngestError } from './ingest-error.js'

export type FileDistiller = (input: {
  buffer: Buffer
  mime: string
  fileName: string
}) => Promise<string>

export type FileIngestorDeps = {
  filesApi: FilesApi
  ingest: BrainEpisodeIngestor
  distill: FileDistiller
  /** Override text extraction in tests. Defaults to parseFileContent. */
  parse?: typeof parseFileContent
}

function needsDistill(mime: string): boolean {
  return mime === 'application/pdf' || mime.startsWith('image/')
}

const EMPTY_COUNTS: FileIngestCounts = { entities: 0, edges: 0, memories: 0, tasks: 0 }

export function createFileIngestor(deps: FileIngestorDeps): FileIngestor {
  const parse = deps.parse ?? parseFileContent

  return async function ingestFile(input, ctx) {
    const filesCtx: FilesContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      assistantId: ctx.assistantId,
      assistantKind: ctx.assistantKind,
      clearance: ctx.clearance,
      compartments: ctx.compartments,
    }
    const sensitivity: FileSensitivity = input.sensitivity ?? 'internal'
    const path = input.path ?? `/uploads/${input.fileName}`

    const stored = await deps.filesApi.writeBytes(filesCtx, {
      path,
      bytes: input.bytes,
      mime: input.mime,
      title: input.fileName,
      sensitivity,
    })
    if (!stored.ok) throw new FileIngestError(stored.error.kind, stored.error)
    const file = stored.value

    /** Shared by every return: the bytes are durable from here on. */
    const base = {
      fileName: input.fileName,
      fileId: file.id,
      path: file.path,
      sizeBytes: file.sizeBytes,
    }

    // Upload is not consent to interpret. The Work Bench uses this branch to
    // create a durable pin while keeping parse/distill/index/Pipeline B behind
    // a later, explicit user decision.
    if (input.process === false) {
      return {
        ...base,
        distilled: false,
        decomposed: false,
        counts: EMPTY_COUNTS,
        skipped: 'not_requested',
      }
    }

    // Audio and video belong to the recording pipeline (transcription, its own
    // segments, its own metering). `parseFileContent` returns '' for audio, so
    // without this branch the result would say `empty` — true, but it reads as
    // "your file had no content" rather than "this lane does not handle it".
    // Same vocabulary the async worker uses.
    if (input.mime.startsWith('audio/') || input.mime.startsWith('video/')) {
      return {
        ...base,
        distilled: false,
        decomposed: false,
        counts: EMPTY_COUNTS,
        skipped: 'media_owned_by_recordings',
      }
    }

    let text: string
    let distilled = false
    let isPlaceholder = false
    if (needsDistill(input.mime)) {
      text = (await deps.distill({ buffer: input.bytes, mime: input.mime, fileName: input.fileName })).trim()
      distilled = true
    } else {
      const parsed = await parse(input.bytes, input.mime, input.fileName)
      text = parsed.text.trim()
      isPlaceholder = parsed.placeholder === true
    }

    // A placeholder is the parser telling us it could not read the file. It is
    // not content, so it must not be chunked into `file_segments` (where it
    // would answer searches as if it were knowledge) and must not be
    // decomposed (a Pipeline B pass costs a model call to summarise a sentence
    // we wrote ourselves). Store the bytes, report the reason, stop.
    if (isPlaceholder) {
      return {
        ...base,
        distilled,
        decomposed: false,
        counts: EMPTY_COUNTS,
        skipped: 'unsupported_type',
      }
    }

    if (!text) {
      return {
        ...base,
        distilled,
        decomposed: false,
        counts: EMPTY_COUNTS,
        skipped: 'empty',
      }
    }

    let segments: number | undefined
    let truncated = false
    let truncatedAtChar: number | null = null
    try {
      const indexed = await indexFileArtifact({
        fileId: file.id,
        workspaceId: ctx.workspaceId,
        text,
        actingUserId: ctx.userId,
      })
      segments = indexed.segmentCount
      truncated = indexed.truncated
      truncatedAtChar = indexed.truncatedAtChar
    } catch (err) {
      // Decomposition still runs — the episode is worth having — but the file
      // is NOT searchable, and this used to be the one path where
      // `metadata.indexing` was never written at all, so the row read as
      // "never indexed" rather than "indexing failed". Stamping it is what
      // lets an operator tell a queued file from a broken one.
      console.error('[files/ingest] segment indexing failed (continuing to decompose):', err)
      await setFileIndexing(file.id, {
        status: 'failed',
        error: err instanceof Error ? err.message.slice(0, 300) : 'unknown error',
        indexedAt: new Date().toISOString(),
      }).catch((stampErr) => {
        console.error('[files/ingest] could not stamp indexing failure:', stampErr)
      })
    }

    const result = await deps.ingest({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      assistantId: ctx.assistantId,
      content: text,
      occurredAt: new Date(),
      sourceLabel: input.fileName,
      sourceKind: 'file_upload',
      sourceRef: { source_kind: 'file_upload', file_id: file.id },
      contentRef: { source_kind: 'file_upload', file_id: file.id },
      sensitivity: toEpisodeSensitivity(sensitivity),
    })

    return {
      ...base,
      distilled,
      decomposed: result.extracted,
      counts: {
        entities: result.entitiesWritten.length,
        edges: result.edgesWritten.length,
        memories: result.memoriesWritten.length,
        tasks: result.tasksWritten.length,
      },
      ...(segments === undefined ? {} : { segments }),
      ...(truncated ? { truncated, ...(truncatedAtChar === null ? {} : { truncatedAtChar }) } : {}),
      ...(result.windowsTotal === undefined ? {} : { windowsTotal: result.windowsTotal }),
      ...(result.windowsFailed ? { windowsFailed: result.windowsFailed } : {}),
    }
  }
}
