import type { AccessContext } from '../security/access-context.js'

/**
 * File cache store interface.
 * API layer implements against the file_cache table.
 */
export type CachedFile = {
  id: string
  sessionId: string
  fileName: string
  mimeType: string
  content: string
  summary: string | null
  sizeBytes: number
  /**
   * Set when the upload was silently promoted to a durable workspace_files
   * artifact (large-content-artifacts §Phase 2.3): the artifact id the chat
   * attach seam renders a manifest for, and its indexed section count.
   * Null/undefined on legacy rows, small files, and inline media.
   */
  artifactFileId?: string | null
  artifactSegmentCount?: number | null
}

export type FileStore = {
  cache(params: {
    sessionId: string
    fileName: string
    mimeType: string
    content: string
    summary?: string
    sizeBytes: number
    expiryDays?: number
    /**
     * Clearance dimensions (2026-06-02 audit #3). Set on upload so the cached
     * file participates in the universal access model: `workspaceId` partitions
     * it to a workspace, `sensitivity` (default 'internal') is the clearance
     * tier. `userId`/`assistantId` left undefined = workspace-shared (like a
     * workspace-visible task). Absent = legacy/unscoped (system contexts).
     */
    workspaceId?: string | null
    userId?: string | null
    assistantId?: string | null
    sensitivity?: 'public' | 'internal' | 'confidential'
  }): Promise<CachedFile>

  /**
   * Read by id. Pass `ctx` to gate the read through the universal access
   * predicate (workspace + visibility + sensitivity ceiling) — every
   * authenticated caller MUST pass it so a file from another workspace/clearance
   * is never returned. Omitting `ctx` is the unscoped legacy read, reserved for
   * the `/preview` route until it moves to signed capability URLs (#3 part 2).
   */
  get(id: string, ctx?: AccessContext): Promise<CachedFile | null>

  getBySession(sessionId: string, ctx?: AccessContext): Promise<CachedFile[]>

  /**
   * Delete every cached file whose `expires_at` has lapsed and return the
   * count removed. Reads already filter `expires_at > now()`, so this is a
   * storage-reclaim sweep, not a correctness gate. Optional: only the DB store
   * runs it (on a jittered interval from boot); in-memory/test stores omit it.
   */
  sweepExpired?(): Promise<number>

  /**
   * Stamp the durable-artifact link on a cached upload after silent promotion
   * (large-content-artifacts §Phase 2.3). Optional: only the DB store carries
   * the columns (migration 299).
   */
  linkArtifact?(id: string, artifactFileId: string, segmentCount: number): Promise<void>
}
