/**
 * Core-layer knowledge store interface.
 *
 * Subset of the API-layer KnowledgeStore — only the methods
 * needed by tools, context builder, and consolidation dedup.
 *
 * Team-scoped: viewer-facing reads take `ctx: AccessContext`, not
 * `(workspaceId, ..., clearance)`. The store filters on
 * ctx.workspaceId + ctx.clearance (passthrough when undefined). See
 * docs/architecture/features/knowledge-base.md and
 * docs/plans/company-brain/permissions.md → WU-4.2b.
 */

import type { AccessContext } from '../security/access-context.js'
import type { Sensitivity } from '../security/sensitivity.js'

export type KnowledgeSearchResult = {
  id: string
  path: string
  title: string
  summary: string | null
  tags: string[]
  sensitivity: Sensitivity
}

export type KnowledgeEntryDetail = {
  id: string
  path: string
  title: string
  content: string
  summary: string | null
  tags: string[]
  relatedIds: string[]
  sensitivity: Sensitivity
  metadata: Record<string, unknown>
  /** Owning sync source. NULL = manually created (no repo behind it). */
  sourceId: string | null
}

export type KnowledgeStoreInterface = {
  search(ctx: AccessContext, query: string, limit?: number): Promise<KnowledgeSearchResult[]>
  listByPath(ctx: AccessContext, pathPrefix: string): Promise<KnowledgeSearchResult[]>
  getById(ctx: AccessContext, id: string): Promise<KnowledgeEntryDetail | null>
  create(params: {
    workspaceId: string
    path: string
    title: string
    content: string
    tags?: string[]
    sensitivity: Sensitivity
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    createdBy?: string | null
  }): Promise<{ id: string; path: string }>
  listSummaries(ctx: AccessContext): Promise<Array<{ id: string; path: string; summary: string | null; sensitivity: Sensitivity }>>
  /**
   * Body-only update of a MANUAL entry (repo-synced entries go through the
   * `KnowledgeRepoWriter`). The store enforces `source_id IS NULL`; null =
   * not found / not manual. Callers must have read-verified access first
   * (`getById` with the session ctx).
   */
  updateManualEntryContent(workspaceId: string, id: string, content: string): Promise<{ id: string; path: string } | null>
  hasEntriesForAssistant(assistantId: string): Promise<boolean>
  listSourcesForAssistant(assistantId: string): Promise<Array<{
    id: string
    repo: string
    sourceType: 'github' | 'local'
    /**
     * Cached PAT write-capability probe (migration 310). `true` = the bound
     * PAT can push; `false`/`null`/absent = read-only (fail closed). Drives
     * the KB write tools' injection gate.
     */
    writeAccess?: boolean | null
  }>>
}

// ── Repo write-back port ───────────────────────────────────────
//
// Implemented API-side (`packages/api/src/knowledge/repo-writer.ts`) over the
// GitHub client + the sync-credential resolver; consumed by the KB write
// tools. A surface without the port simply never injects the repo write
// tools — capability-honest degradation, mirroring the sync worker's
// credential stub. See docs/architecture/features/knowledge-base.md →
// "Assistant direct edits".

export type KnowledgeRepoWriteResult =
  | {
      ok: true
      entryId: string
      path: string
      sourceType: 'github' | 'local'
      commitSha: string | null
      commitUrl: string | null
    }
  | {
      ok: false
      /**
       * `not_writable` — source's cached probe says no push access.
       * `push_denied` — GitHub rejected the write (403); the cache is flipped
       *   to read-only as a side effect.
       * `no_credentials` — bound connector missing/empty PAT, or the PAT is
       *   dead (401 — connector-health owns the instance state).
       * `source_missing` — the entry's source row is gone or malformed.
       * `stale_entry` — the repo body moved ahead of the synced DB copy;
       *   retry after the next sync.
       * `file_missing` — no repo file resolves to the entry path.
       * `file_exists` — create target already has a file (use update).
       * `error` — anything else (network, GitHub 5xx).
       */
      reason:
        | 'not_writable'
        | 'push_denied'
        | 'no_credentials'
        | 'source_missing'
        | 'stale_entry'
        | 'file_missing'
        | 'file_exists'
        | 'error'
      message: string
    }

export type KnowledgeRepoWriter = {
  /**
   * Commit a body-only edit of an existing repo-synced entry to the source
   * branch, preserving the live file's frontmatter verbatim, then eagerly
   * write the result through to `knowledge_entries` (same parse+upsert the
   * sync worker runs, so DB state matches what the next tick would produce).
   */
  commitEntryUpdate(params: {
    workspaceId: string
    entry: { id: string; path: string; content: string; sourceId: string }
    newBody: string
    changeSummary: string
    /**
     * The requesting member: `userId` keys the `kb_repo_write` audit event,
     * `label` (email) lands in the commit-message attribution trailer.
     */
    requestedBy?: { userId: string; label?: string | null } | null
  }): Promise<KnowledgeRepoWriteResult>
  /**
   * Commit a new entry file (`<rootPath>/<path>.md`, full markdown including
   * generated frontmatter) to the source branch, then write it through to
   * `knowledge_entries`.
   */
  commitEntryCreate(params: {
    workspaceId: string
    sourceId: string
    path: string
    fileContent: string
    changeSummary: string
    requestedBy?: { userId: string; label?: string | null } | null
  }): Promise<KnowledgeRepoWriteResult>
}
