/**
 * FilesApi — surface the chat tools call. Implementation lives in the
 * API layer (`packages/api/src/files/files-api.ts`) and stitches together
 * the GCS client + workspace-files store + audit emission.
 *
 * Decoupled from the store and GCS so the core package can be tested
 * with a fake FilesApi without pulling pg or @google-cloud/storage.
 */

import type { Sensitivity } from '../security/sensitivity.js'
import type {
  FileSensitivity,
  WorkspaceFile,
  WorkspaceFileIndexRow,
  WorkspaceFileMetaPatch,
} from './types.js'

export type FilesContext = {
  workspaceId: string
  userId: string
  assistantId?: string | null
  /**
   * Calling assistant's kind. Drives whether the universal access
   * predicate drops the assistant_id partition (primary widens to
   * workspace-wide). Absent = legacy caller; treated as 'standard'.
   */
  assistantKind?: 'primary' | 'standard' | 'app'
  /**
   * Maximum sensitivity the actor may read. Undefined = passthrough
   * (system callers; default behaviour pre-WU-4.2b).
   */
  clearance?: Sensitivity
  /**
   * Effective compartment grant (MLS category axis — `member ∩ assistant`).
   * Forwarded to `buildAccessPredicate`'s `compartments <@ $grant` clause.
   * `null`/`undefined` = universe (clause dropped). See docs/plans/compartment-axis.md.
   */
  compartments?: string[] | null
}

export type FilesQuotaError = {
  kind: 'quota_exceeded'
  currentBytes: number
  limitBytes: number
  attemptedBytes: number
}

export type FilesNotFoundError = {
  kind: 'not_found'
  reference: string
}

export type FilesConflictError = {
  kind: 'conflict'
  path: string
}

export type FilesError = FilesQuotaError | FilesNotFoundError | FilesConflictError

export type FilesResult<T> = { ok: true; value: T } | { ok: false; error: FilesError }

export type FilesWriteParams = {
  path: string
  content: string
  /** Inferred from extension when omitted. */
  mime?: string
  title?: string | null
  summary?: string | null
  tags?: string[]
  sensitivity?: FileSensitivity
}

/**
 * Like {@link FilesWriteParams} but carries raw bytes verbatim instead of a
 * UTF-8 string — the path used to promote a cached upload (image, PDF, any
 * binary) into the workspace file primitive without corrupting it. `mime` is
 * required (binary can't be inferred from a string).
 */
export type FilesWriteBytesParams = {
  path: string
  bytes: Uint8Array
  mime: string
  title?: string | null
  summary?: string | null
  tags?: string[]
  sensitivity?: FileSensitivity
}

export type FilesReadResult = {
  file: WorkspaceFile
  content: string
}

/** Byte-preserving read — the read mirror of {@link FilesWriteBytesParams}. */
export type FilesReadBytesResult = {
  file: WorkspaceFile
  bytes: Uint8Array
}

export type FilesSearchParams = {
  query?: string
  tag?: string
  parentPath?: string
  limit?: number
}

/**
 * The surface chat tools call. Each method takes a `FilesContext` so the
 * tool's `execute(input, context)` can pass it through transparently.
 *
 * Errors land in the `FilesResult` envelope where they are user-facing
 * (quota, not-found, conflict). Other failures throw.
 */
export type FilesApi = {
  write(ctx: FilesContext, params: FilesWriteParams): Promise<FilesResult<WorkspaceFile>>

  /** Write raw bytes verbatim (binary-safe). Used to persist an uploaded
   *  attachment to the workspace file primitive, preserving the original. */
  writeBytes(ctx: FilesContext, params: FilesWriteBytesParams): Promise<FilesResult<WorkspaceFile>>

  append(ctx: FilesContext, idOrPath: string, content: string): Promise<FilesResult<WorkspaceFile>>

  /** Metadata only — no blob fetch. Backs `sendFile`'s gates (sensitivity, size). */
  stat(ctx: FilesContext, idOrPath: string): Promise<FilesResult<WorkspaceFile>>

  read(ctx: FilesContext, idOrPath: string): Promise<FilesResult<FilesReadResult>>

  /** Row + raw bytes, byte-preserving (binary-safe — `read` decodes UTF-8 and
   *  would corrupt binary). Backs outbound document delivery. */
  readBytes(ctx: FilesContext, idOrPath: string): Promise<FilesResult<FilesReadBytesResult>>

  search(ctx: FilesContext, params: FilesSearchParams): Promise<WorkspaceFileIndexRow[]>

  setMeta(
    ctx: FilesContext,
    idOrPath: string,
    patch: WorkspaceFileMetaPatch,
  ): Promise<FilesResult<WorkspaceFile>>

  delete(ctx: FilesContext, idOrPath: string): Promise<FilesResult<{ id: string; path: string }>>
}
