/**
 * Workspace files store interface.
 *
 * Workspace-scoped file index — bytes live in GCS, structure and discovery
 * live here (see docs/architecture/features/files.md). Schema is the
 * KB-shaped Phase A locked design (company-brain §10): path-based
 * hierarchy, title/summary/tags/related_ids, search_vector. Migration 128
 * (WS-2) added the universal column set — visibility double, authorship,
 * trust signals, bi-temporal supersession, retraction — exposed here.
 *
 * Read methods take `ctx: AccessContext` (WU-4.2b) so the store can
 * compose the universal access predicate (workspace + visibility double
 * + sensitivity ≤ clearance) consistently with the rest of the brain.
 *
 * Draft lifecycle (SV(2) — see docs/architecture/brain/corrections.md
 * §D.7 "Draft file lifecycle"):
 *   - `tags @> ['draft']` while iterating
 *   - Substantive (content) edits supersede via `supersede()` — atomic
 *     close of the prior row's bi-temporal window + insert of a successor
 *   - Metadata-only edits (tags, sensitivity, title, summary) stay
 *     in-place via `updateMeta()`
 *   - Lock-in convention: remove `'draft'` tag, optionally add
 *     `'final'` / `'final:<commit_sha>'` via `updateMeta`
 *   - `getHistory()` walks the supersession chain for the D.7 audit
 *
 * Naming note: this module is `workspace-files/` to avoid collision with
 * `packages/core/src/files/` (the inline-media parsers + read-file tool
 * for chat attachments — a different subsystem).
 *
 * Injected by the API layer into `createFileTools`. The core package has
 * no direct DB dependency — concrete impl lives in
 * `packages/api/src/db/workspace-files-store.ts`.
 */

import type { AccessContext } from '../security/access-context.js'

export const FILE_SENSITIVITIES = ['public', 'internal', 'confidential'] as const
export type FileSensitivity = (typeof FILE_SENSITIVITIES)[number]

export type WorkspaceFileMetadata = Record<string, unknown>

export type WorkspaceFile = {
  id: string
  workspaceId: string
  path: string
  parentPath: string
  name: string
  title: string | null
  summary: string | null
  mime: string
  sizeBytes: number
  tags: string[]
  relatedIds: string[]
  storageUri: string
  sensitivity: FileSensitivity
  metadata: WorkspaceFileMetadata
  // Visibility double (mig 128). Both nullable; (NULL, NULL) means
  // workspace-shared default.
  userId: string | null
  assistantId: string | null
  // Trust + provenance (mig 128).
  source: string
  sourceEpisodeId: string | null
  verifiedByUserId: string | null
  verifiedAt: Date | null
  // Bi-temporal window (mig 128). `validTo === null` is the current row;
  // a closed window indicates this row was superseded or retracted.
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  // Retraction (mig 128).
  retractedAt: Date | null
  retractedReason: string | null
  retractedBy: string | null
  // Authorship (mig 128 renamed `created_by` → `created_by_user_id`).
  createdByUserId: string | null
  createdByAssistantId: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Derived row status per D.7 status enum (corrections.md §D.7).
 * `archived` is not used for workspace_files — drafts retire via
 * supersession, not archive.
 */
export type WorkspaceFileRowStatus = 'active' | 'superseded' | 'retracted'

export function workspaceFileStatus(row: WorkspaceFile): WorkspaceFileRowStatus {
  if (row.retractedAt) return 'retracted'
  if (row.validTo) return 'superseded'
  return 'active'
}

/**
 * Compact projection used by listIndexRanked / listByPath / searchByText —
 * omits `metadata` to keep model-facing payloads small.
 */
export type WorkspaceFileIndexRow = Pick<
  WorkspaceFile,
  'id' | 'workspaceId' | 'path' | 'parentPath' | 'name' | 'title' | 'summary' | 'mime' | 'sizeBytes' | 'tags' | 'sensitivity' | 'updatedAt'
>

export type WorkspaceFileCreateInput = {
  /**
   * Optional explicit row id. The API layer generates this so the GCS
   * object key (`<workspace_id>/<file_id>`) and the DB row share the same
   * uuid; without this the two diverge and `read`/`delete` round-trips
   * miss the blob. When omitted, the DB default (`gen_random_uuid()`)
   * applies — useful for tests / sync workers that don't write blobs.
   */
  id?: string
  workspaceId: string
  path: string
  parentPath: string
  name: string
  mime: string
  sizeBytes: number
  storageUri: string
  title?: string | null
  summary?: string | null
  tags?: string[]
  relatedIds?: string[]
  sensitivity?: FileSensitivity
  /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
  compartments?: string[]
  metadata?: WorkspaceFileMetadata
  /** mig 128 rename — was `createdBy`. */
  createdByUserId?: string | null
  createdByAssistantId?: string | null
  // Universal column inputs (mig 128). Default visibility is workspace-
  // shared (both null); default `source` is 'user' (DB default).
  userId?: string | null
  assistantId?: string | null
  source?: string
  sourceEpisodeId?: string | null
}

export type WorkspaceFileMetaPatch = {
  /** Pass `null` to clear; omit to leave unchanged. */
  title?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  summary?: string | null
  /**
   * Tag changes are the lock-in mechanism for the SV(2) draft lifecycle:
   * remove `'draft'`, add `'final'` (or `'final:<commit_sha>'`) once the
   * draft is locked in. Per corrections.md §D.7, metadata-only changes
   * stay in-place — content edits route through `supersede` instead.
   */
  tags?: string[]
  relatedIds?: string[]
  sensitivity?: FileSensitivity
  metadata?: WorkspaceFileMetadata
}

/**
 * Substantive-edit input for `supersede()`. Required: new content
 * (storageUri + sizeBytes) and the editor's identity for authorship.
 * Optional: metadata patches applied to the successor row.
 */
export type WorkspaceFileSupersedePatch = {
  /** Stamped on the successor as `created_by_user_id`. */
  editorUserId: string
  /** Stamped on the successor as `created_by_assistant_id`. */
  editorAssistantId?: string | null
  /** Successor content. */
  storageUri: string
  sizeBytes: number
  mime?: string
  /**
   * Optional successor path. The SV(2) convention is path-stable
   * (omit and the successor inherits the prior row's path); however
   * mig 119's `UNIQUE (workspace_id, path)` is not yet partial on
   * `valid_to IS NULL`, so path-stable supersession trips the
   * constraint. Pass an alternate path to work around this until a
   * follow-up migration relaxes the constraint.
   */
  path?: string
  parentPath?: string
  name?: string
  /** Optional metadata overrides; omitted fields inherit from the prior row. */
  title?: string | null
  summary?: string | null
  tags?: string[]
  relatedIds?: string[]
  sensitivity?: FileSensitivity
  metadata?: WorkspaceFileMetadata
}

export type WorkspaceFilesStore = {
  /**
   * Insert a row. Throws on UNIQUE(workspace_id, path) collision — the
   * caller decides whether to surface as overwrite (delete + create) or
   * a clear error.
   */
  create(userId: string, input: WorkspaceFileCreateInput): Promise<WorkspaceFile>

  /** Viewer-projected (WU-4.2b). Returns null when the row is hidden or non-existent. Current-version only (filters `valid_to IS NULL`). */
  getById(ctx: AccessContext, id: string): Promise<WorkspaceFile | null>

  /** Viewer-projected. Returns null when the row is hidden or non-existent. Current-version only. */
  getByPath(ctx: AccessContext, path: string): Promise<WorkspaceFile | null>

  /** In-place metadata patch on the current row. Returns null if no current row matches. */
  updateMeta(
    userId: string,
    workspaceId: string,
    id: string,
    patch: WorkspaceFileMetaPatch,
  ): Promise<WorkspaceFile | null>

  /** Bumps size_bytes after a GCS append. Used by files-api append. Current-row gated. */
  updateSize(
    userId: string,
    workspaceId: string,
    id: string,
    sizeBytes: number,
  ): Promise<WorkspaceFile | null>

  /** Returns true if a row was deleted. Current-row gated. */
  delete(userId: string, workspaceId: string, id: string): Promise<boolean>

  /**
   * Hierarchy listing — files whose `parent_path` exactly matches `prefix`
   * (direct children). Pass `''` for the workspace root tier.
   */
  listByPath(
    ctx: AccessContext,
    opts: { prefix?: string; limit?: number; offset?: number },
  ): Promise<WorkspaceFileIndexRow[]>

  /**
   * Full-text search over title/summary/tags/name (search_vector).
   * Optional `tag` filters by exact tag membership. Optional
   * `parentPath` scopes to a folder.
   */
  searchByText(
    ctx: AccessContext,
    opts: { query?: string; tag?: string; parentPath?: string; limit?: number },
  ): Promise<WorkspaceFileIndexRow[]>

  /**
   * Powers the `# Workspace Files` L1 prompt block. Returns most-recently-
   * updated rows up to `limit`. Viewer-projected. Current-version only.
   */
  listIndexRanked(
    ctx: AccessContext,
    limit: number,
  ): Promise<WorkspaceFileIndexRow[]>

  /**
   * Sum of `size_bytes` across current rows of the workspace. Used by
   * the quota check in `files-api.write` / `files-api.append`.
   * Best-effort under concurrent writes — see
   * `docs/architecture/features/files.md` quota note. Historical
   * (superseded) rows are excluded.
   */
  sumSizeBytes(ctx: AccessContext): Promise<number>

  /**
   * Atomic supersession (SV(2)). Closes the current row's bi-temporal
   * window (`valid_to = now()`, `superseded_by = newId`) and inserts a
   * successor (`valid_from = now()`). Returns the successor row, or
   * null if the source id has no current row.
   *
   * Called by the WU-6 staged_write approval flow when an iteration
   * lands. The legacy UNIQUE(workspace_id, path) constraint on mig 119
   * blocks path-stable supersession; a follow-up migration must make
   * the constraint partial (`WHERE valid_to IS NULL`) before the SV(2)
   * convention works end-to-end.
   */
  supersede(
    userId: string,
    workspaceId: string,
    id: string,
    patch: WorkspaceFileSupersedePatch,
  ): Promise<WorkspaceFile | null>

  /**
   * D.7 audit walk — every version in this row's supersession chain,
   * ordered oldest → newest by `valid_from`. Bypasses the default
   * current-version filter so retracted / superseded versions are
   * included. Viewer-projected; chain rows share the universal-column
   * tuple per D.7 so the predicate gates the anchor only.
   */
  getHistory(
    ctx: AccessContext,
    id: string,
  ): Promise<WorkspaceFile[]>

  /**
   * System-level (no RLS) soft-retraction of every current row whose bytes
   * live in `bucket` under `scheme`. Used by the
   * bring-your-own-storage staleness sweep when a disconnected binding's
   * bucket goes stale and its key is wiped — the bytes are unreadable, so the
   * index rows are retracted to stop surfacing dead references. Returns the
   * number of rows retracted.
   */
  retractByStorageBucketSystem(
    workspaceId: string,
    bucket: string,
    scheme: 'gs' | 's3',
    reason: string,
  ): Promise<number>
}
