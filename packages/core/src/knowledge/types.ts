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
  hasEntriesForAssistant(assistantId: string): Promise<boolean>
  listSourcesForAssistant(assistantId: string): Promise<Array<{ id: string; repo: string }>>
}
