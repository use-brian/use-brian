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

/**
 * Why a stored file was not decomposed. `decomposed: false` says *that* it
 * wasn't; this says why, so the caller can tell the user something better than
 * silence. Vocabulary is shared with the async worker's skip reasons.
 */
export type FileIngestSkipReason =
  /** The parser returned its own note, not content (legacy .doc, unknown type). */
  | 'unsupported_type'
  /** Audio / video belong to the recording pipeline, never to file chunking. */
  | 'media_owned_by_recordings'
  /** Extraction produced no text at all. */
  | 'empty'
  /** Storage-only by request — `process: false`. */
  | 'not_requested'

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
  /**
   * Segments written to `file_segments` — the retrieval surface. Absent when
   * indexing did not run.
   */
  segments?: number
  /**
   * True when `MAX_SEGMENTS_PER_FILE` stopped chunking before the file's tail,
   * so part of the document is stored but NOT retrievable.
   *
   * This was previously written only to `workspace_files.metadata.indexing`,
   * which no user surface reads — a 4.1 MB upload lost 29% of its text to the
   * cap and reported success. A ceiling may shape what reaches the model, but
   * a ceiling the user cannot see is indistinguishable from a complete read.
   */
  truncated?: boolean
  /** Offset where the un-chunked tail begins, when `truncated`. */
  truncatedAtChar?: number
  /** Present when the file was stored but not decomposed. */
  skipped?: FileIngestSkipReason
}

export type FileIngestor = (
  input: FileIngestInput,
  ctx: FileIngestContext,
) => Promise<FileIngestResult>
