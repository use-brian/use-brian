/**
 * File-ingest PORT — the function-type contract for the direct file ingestor.
 *
 * The impl (`files/ingest-file.ts::createFileIngestor`) is closed (it drives the
 * Pipeline B ingest, a closed moat surface). The open `routes/files.ts` references
 * the `FileIngestor` injected-dependency TYPE, so the contract lives here, open;
 * the closed impl imports + re-exports it. See oss-local-brain-wedge.md §12.5.
 */

import type { FileSensitivity, Sensitivity } from '@sidanclaw/core'

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
