/**
 * File-ingest contract shared by the upload route, direct ingestor and queue worker.
 *
 * The implementation lives beside this contract in `files/ingest-file.ts` and
 * drives the open Pipeline B ingestor built by boot.
 */

import type { FileSensitivity } from '@use-brian/core/workspace-files/types.js'
import type { Sensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'

/**
 * Ceiling on what is INTERPRETED, as opposed to stored. The worker reads a
 * stored file whole into memory before parsing, and the office parsers hold
 * their own expansions beside it; the hosted worker runs at 1 GiB and an
 * Outpost API shares 4 GiB with five sibling services, so a multi-gigabyte
 * document would take the process down rather than fail its own job. Same
 * figure as `MAX_OFFICE_ARCHIVE_ENTRY_BYTES`. Enforced here (stat before
 * read) and at `POST /api/files/:fileId/ingest`, which answers `stored_only`
 * instead of queueing. Spec: files.md -> "Stored is not the same as analyzed".
 */
export const MAX_INGEST_PARSE_BYTES = 128 * 1024 * 1024

export type FileIngestContext = {
  workspaceId: string
  userId: string
  assistantId: string
  assistantKind?: 'primary' | 'standard' | 'app'
  clearance?: Sensitivity
  compartments?: string[] | null
  projectIds?: string[] | null
  writeCompartments?: string[]
  writeProjectIds?: string[]
}

export type FileIngestInput = {
  fileName: string
  mime: string
  bytes: Buffer
  /**
   * Whether to derive text and run Pipeline B after storing the bytes.
   * Defaults to true. Chat/pin staging passes false so durability never
   * implies consent to interpret the file.
   */
  process?: boolean
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
  alreadyIngested?: boolean
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
