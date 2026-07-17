/**
 * createFileIngestor - the shared "drop a file into the brain" routine.
 *
 * One file:
 *   1. stores the original bytes in workspace_files,
 *   2. derives text locally or through an injected PDF/image distiller,
 *   3. indexes segments and decomposes the text through Pipeline B.
 *
 * [COMP:files/ingest]
 */

import {
  parseFileContent,
  type FilesApi,
  type FilesContext,
  type FileSensitivity,
} from '@sidanclaw/core'
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

    let text: string
    let distilled = false
    if (needsDistill(input.mime)) {
      text = (await deps.distill({ buffer: input.bytes, mime: input.mime, fileName: input.fileName })).trim()
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
