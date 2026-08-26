/**
 * createFileIngestor - the shared "drop a file into the brain" routine.
 *
 * One file:
 *   1. stores the original bytes in workspace_files,
 *   2. when `process !== false`, derives text locally or through an injected
 *      PDF/image distiller,
 *   3. indexes segments and decomposes the text through Pipeline B.
 *
 * [COMP:files/ingest]
 */

import {
  detectDocumentFormat,
  documentMimeType,
  parseFileContent,
  type FilesApi,
  type FilesContext,
  type FileSensitivity,
} from '@use-brian/core'
import { toEpisodeSensitivity } from '../episode-sensitivity.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import { indexFileArtifact } from './artifact-index.js'
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
    // A store-only pin is reversible staging, not consent to interpret bytes.
    // Content detection begins only on the explicit processing path.
    const detectedFormat =
      input.process === false
        ? undefined
        : await detectDocumentFormat(input.bytes, input.mime, input.fileName)
    const effectiveMime = detectedFormat ? documentMimeType(detectedFormat) : input.mime
    const filesCtx: FilesContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      assistantId: ctx.assistantId,
      assistantKind: ctx.assistantKind,
      clearance: ctx.clearance,
      compartments: ctx.compartments,
      projectIds: ctx.projectIds,
      writeCompartments: ctx.writeCompartments,
      writeProjectIds: ctx.writeProjectIds,
    }
    const sensitivity: FileSensitivity = input.sensitivity ?? 'internal'
    const path = input.path ?? `/uploads/${input.fileName}`

    const stored = await deps.filesApi.writeBytes(filesCtx, {
      path,
      bytes: input.bytes,
      mime: effectiveMime,
      title: input.fileName,
      sensitivity,
    })
    if (!stored.ok) throw new FileIngestError(stored.error.kind, stored.error)
    const file = stored.value

    // Upload alone is not consent to interpret — this branch only files bytes.
    // The Work Bench stores through here to create a durable pin, then (since
    // dropping a file on Pins IS consent to save it to the brain, 2026-08-07)
    // separately queues the stored file through the explicit stored-file
    // ingest lane (`POST /api/files/:fileId/ingest`).
    if (input.process === false) {
      return {
        fileName: input.fileName,
        fileId: file.id,
        path: file.path,
        sizeBytes: file.sizeBytes,
        distilled: false,
        decomposed: false,
        counts: EMPTY_COUNTS,
      }
    }

    let text: string
    let distilled = false
    if (needsDistill(effectiveMime)) {
      text = (await deps.distill({ buffer: input.bytes, mime: effectiveMime, fileName: input.fileName })).trim()
      distilled = true
    } else {
      const parsed = await parse(input.bytes, input.mime, input.fileName)
      text = parsed.text.trim()
    }

    if (text) {
      try {
        await indexFileArtifact({
          fileId: file.id,
          workspaceId: ctx.workspaceId,
          text,
          actingUserId: ctx.userId,
        })
      } catch (err) {
        console.error('[files/ingest] segment indexing failed (continuing to decompose):', err)
      }
    }

    if (!text) {
      return {
        fileName: input.fileName,
        fileId: file.id,
        path: file.path,
        sizeBytes: file.sizeBytes,
        distilled,
        decomposed: false,
        counts: EMPTY_COUNTS,
      }
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
      compartments: file.compartments,
      projectIds: file.projectIds,
    })

    return {
      fileName: input.fileName,
      fileId: file.id,
      path: file.path,
      sizeBytes: file.sizeBytes,
      distilled,
      decomposed: result.extracted,
      counts: {
        entities: result.entitiesWritten.length,
        edges: result.edgesWritten.length,
        memories: result.memoriesWritten.length,
        tasks: result.tasksWritten.length,
      },
    }
  }
}
