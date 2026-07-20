/**
 * File-ingest PORT — the function-type contract for the direct file ingestor.
 *
 * The implementation lives beside this contract in `files/ingest-file.ts` and
 * drives the open Pipeline B ingestor built by boot.
 */

import type { FileSensitivity, Sensitivity } from '@use-brian/core'

export type FileIngestContext = {
  workspaceId: string
  userId: string
  assistantId: string
  assistantKind?: 'primary' | 'standard' | 'app'
  clearance?: Sensitivity
  compartments?: string[] | null
}

export type FileIngestInput = {
  fileName: string
  mime: string
  bytes: Buffer
  /** Defaults to `/uploads/<fileName>`. */
  path?: string
  /** File-row sensitivity. Defaults to `internal`. */
  sensitivity?: FileSensitivity
}

export type FileIngestCounts = {
  entities: number
  edges: number
  memories: number
  tasks: number
}

export type FileIngestResult = {
  fileName: string
  fileId: string
  path: string
  sizeBytes: number
  /** True when a model distillation produced the ingested text (PDF/image). */
  distilled: boolean
  /** True when text was decomposed through Pipeline B (false = stored only). */
  decomposed: boolean
  counts: FileIngestCounts
}

export type FileIngestor = (
  input: FileIngestInput,
  ctx: FileIngestContext,
) => Promise<FileIngestResult>
