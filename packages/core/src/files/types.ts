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
}
