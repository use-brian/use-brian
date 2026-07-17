/**
 * Knowledge store — team-scoped knowledge entries + team knowledge sources.
 *
 * Entries are deduplicated at (workspace_id, path). Viewer-facing reads
 * take an `AccessContext` (WU-4.2b) and filter on workspace_id +
 * sensitivity_rank() (migration 065). The per-assistant dimension is gone
 * — an assistant sees its team's canonical entries subset to its
 * clearance at read time. System callers (sync worker, audit) bypass
 * clearance via the `*System` parallel methods.
 *
 * Note on `buildAccessPredicate` — the universal predicate's
 * visibility-double clauses reference `user_id` and `assistant_id`
 * columns which knowledge_entries does NOT carry (the table is purely
 * workspace-scoped by design — migration 082 dropped the per-assistant
 * dimension). So this store composes its own narrower predicate
 * (workspace_id + sensitivity) inline rather than calling the helper.
 *
 * See docs/architecture/features/knowledge-base.md and
 * docs/architecture/platform/sensitivity.md.
 */

import type { AccessContext, Sensitivity } from '@use-brian/core'
import { query } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type KnowledgeEntry = {
  id: string
  workspaceId: string
  path: string
  title: string
  summary: string | null
  content: string
  tags: string[]
  relatedIds: string[]
  sensitivity: Sensitivity
  metadata: Record<string, unknown>
  sourceId: string | null
  sourceSha: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type KnowledgeSource = {
  id: string
  workspaceId: string
  sourceType: 'github'
  repo: string
  branch: string
  rootPath: string
  lastSyncedSha: string | null
  lastSyncedAt: Date | null
  syncError: string | null
  /** The connector_instance this source syncs through. NULL = legacy by-workspace resolution. */
  connectorInstanceId: string | null
  /**
   * Cached PAT write-capability probe (migration 310): can the bound PAT
   * push to the repo? NULL = never probed — treated as read-only. Refreshed
   * by the sync worker each tick, at source creation, and on call-time 403.
   */
  writeAccess: boolean | null
  writeAccessCheckedAt: Date | null
  createdAt: Date
}

// ── Column lists ───────────────────────────────────────────────

// Unaliased — used by writes (INSERT ... RETURNING) and system callers
// that don't need a clearance-scoped related_ids filter.
const ENTRY_COLUMNS = `
  id, workspace_id AS "workspaceId",
  path, title, summary, content, tags, related_ids AS "relatedIds",
  sensitivity, metadata, source_id AS "sourceId", source_sha AS "sourceSha",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
` as const

/**
 * Column list for clearance-scoped reads. Expects the table aliased as `ke`.
 * `related_ids` is replaced with a subquery that drops any id whose entry is
 * above the caller's clearance — otherwise a public-cleared caller reading a
 * public entry learns UUIDs of confidential siblings via the related array.
 *
 * `$clearanceIdx` is the 1-based parameter position of the clearance value
 * in the enclosing query.
 */
function entryColumnsClearanceScoped(clearanceIdx: number): string {
  return `
    ke.id, ke.workspace_id AS "workspaceId",
    ke.path, ke.title, ke.summary, ke.content, ke.tags,
    COALESCE((
      SELECT array_agg(ke2.id)
      FROM knowledge_entries ke2
      WHERE ke2.id = ANY(ke.related_ids)
        AND sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($${clearanceIdx})
    ), ARRAY[]::uuid[]) AS "relatedIds",
    ke.sensitivity, ke.metadata,
    ke.source_id AS "sourceId", ke.source_sha AS "sourceSha",
    ke.created_by AS "createdBy", ke.created_at AS "createdAt", ke.updated_at AS "updatedAt"
  `
}

const DEFAULT_CLEARANCE: Sensitivity = 'confidential'

/**
 * SQL fragment: the entry's source is NOT on the reading assistant's
 * per-assistant denylist (`assistant_disabled_knowledge_sources`).
 * `assistantIdx` is the 1-based position of the `assistant_id` parameter in
 * the enclosing query. Manually-created entries (`source_id IS NULL`) never
 * match the subquery, so they are always visible. Applied only on the
 * assistant consumption path (search / browse / read), never on the
 * workspace-scoped brain/graph projections or the system sync reads.
 *
 * See docs/architecture/features/knowledge-base.md → "Per-assistant source scoping".
 */
function sourceNotDisabled(assistantIdx: number, alias = 'ke'): string {
  return `NOT EXISTS (
    SELECT 1 FROM assistant_disabled_knowledge_sources adks
    WHERE adks.assistant_id = $${assistantIdx} AND adks.source_id = ${alias}.source_id
  )`
}

/**
 * Whether the per-assistant source denylist applies to this read. Primary /
 * reflector contexts (the workspace coordinator, and the brain explorer — which
 * sets `assistantKind='primary'` with a non-functional viewpoint id) span every
 * source, mirroring how the universal access predicate drops the `assistant_id`
 * partition for primary (see access-context.ts → "Primary widens"). Standard /
 * app assistants get per-assistant scoping. Skipping primary also keeps the
 * brain list (unfiltered) and the brain detail drawer (`getById`) consistent.
 */
function appliesDenylist(ctx: AccessContext): boolean {
  return ctx.assistantKind !== 'primary'
}

const SOURCE_COLUMNS = `
  id, workspace_id AS "workspaceId", source_type AS "sourceType",
  repo, branch, root_path AS "rootPath",
  last_synced_sha AS "lastSyncedSha", last_synced_at AS "lastSyncedAt",
  sync_error AS "syncError", connector_instance_id AS "connectorInstanceId",
  write_access AS "writeAccess", write_access_checked_at AS "writeAccessCheckedAt",
  created_at AS "createdAt"
` as const

// ── Store ──────────────────────────────────────────────────────

export type KnowledgeStore = {
  // Viewer-facing entry reads — gated by ctx (workspace + clearance).
  // `ctx.clearance === undefined` is treated as passthrough ('confidential').
  search(ctx: AccessContext, queryStr: string, limit?: number): Promise<KnowledgeEntry[]>
  listByPath(ctx: AccessContext, pathPrefix: string): Promise<KnowledgeEntry[]>
  getById(ctx: AccessContext, id: string): Promise<KnowledgeEntry | null>
  getByPath(ctx: AccessContext, path: string): Promise<KnowledgeEntry | null>
  listSummaries(ctx: AccessContext): Promise<Array<{ id: string; path: string; summary: string | null; sensitivity: Sensitivity }>>
  /**
   * Brain list-view projection: id + title + path + sensitivity, capped at
   * `limit`. Empty `query` returns the most-recently-updated entries; a
   * non-empty `query` runs the same FTS as `search` so the brain `/list`
   * surface and the chat `searchKnowledge` tool agree on hits.
   */
  listForBrain(
    ctx: AccessContext,
    queryStr: string,
    limit: number,
  ): Promise<Array<{ id: string; title: string; path: string; sensitivity: Sensitivity }>>
  /**
   * Graph-view projection: every visible knowledge entry plus its
   * clearance-scoped `relatedIds`. Powers the knowledge-as-node /
   * knowledge↔knowledge-edge layer of the brain graph. Capped at
   * `limit` rows; the graph route then merges this with the entity
   * sweep before truncating to the overall node cap.
   */
  listForGraph(
    ctx: AccessContext,
    limit: number,
  ): Promise<Array<{ id: string; title: string; path: string; sensitivity: Sensitivity; relatedIds: string[] }>>
  /**
   * Resolve a set of entry ids to their display refs (id + title + path),
   * workspace- and clearance-scoped. Backs the brain knowledge detail's
   * `related` projection (wikilink targets in the entry reader). Order
   * follows `path` for a stable rail list.
   */
  listByIds(
    ctx: AccessContext,
    ids: string[],
  ): Promise<Array<{ id: string; title: string; path: string; sensitivity: Sensitivity }>>
  listPaths(ctx: AccessContext): Promise<string[]>
  hasEntries(ctx: AccessContext): Promise<boolean>

  // System-level reads — privileged-service callers (sync worker,
  // audit) that bypass per-viewer projection. See permissions.md
  // § Privileged-service exception.
  getByPathSystem(workspaceId: string, path: string): Promise<KnowledgeEntry | null>
  listPathsSystem(workspaceId: string): Promise<string[]>

  create(params: {
    workspaceId: string; path: string; title: string
    summary?: string | null; content: string; tags?: string[]; sensitivity: Sensitivity
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    metadata?: Record<string, unknown>
    sourceId?: string | null; sourceSha?: string | null; createdBy?: string | null
  }): Promise<KnowledgeEntry>
  upsertByPath(params: {
    workspaceId: string; path: string; title: string
    summary?: string | null; content: string; tags?: string[]; relatedIds?: string[]
    sensitivity: Sensitivity
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    metadata?: Record<string, unknown>; sourceId?: string | null; sourceSha?: string | null
  }): Promise<KnowledgeEntry>
  /**
   * Body-only update of a MANUAL entry (`source_id IS NULL` enforced in the
   * predicate — repo-synced entries change through the repo writer, never
   * here). Touches `content` + `updated_at` only, so tags / sensitivity /
   * compartments / related_ids survive untouched. Returns null when the id
   * doesn't resolve to a manual entry in the workspace.
   */
  updateManualEntryContent(workspaceId: string, id: string, content: string): Promise<{ id: string; path: string } | null>
  delete(id: string): Promise<boolean>
  deleteBySource(sourceId: string): Promise<number>
  deleteByTeamAndPath(workspaceId: string, path: string): Promise<boolean>
  deleteByTeamAndPathPrefix(workspaceId: string, pathPrefix: string): Promise<number>
  updateRelatedIds(id: string, relatedIds: string[]): Promise<void>
  hasEntriesForAssistant(assistantId: string): Promise<boolean>

  // Sources
  createSource(params: {
    workspaceId: string; sourceType: 'github'; repo: string; branch?: string; rootPath?: string
    /** The connector_instance whose PAT this source syncs through. */
    connectorInstanceId?: string | null
  }): Promise<KnowledgeSource>
  getSource(id: string): Promise<KnowledgeSource | null>
  listSources(workspaceId: string): Promise<KnowledgeSource[]>
  listSourcesForAssistant(assistantId: string): Promise<KnowledgeSource[]>
  deleteSource(id: string): Promise<boolean>
  updateSourceSync(id: string, sha: string, error?: string | null): Promise<void>
  /** Persist the PAT write-capability probe result (migration 310). */
  updateSourceWriteAccess(id: string, writeAccess: boolean): Promise<void>
  getSourcesDueForSync(): Promise<KnowledgeSource[]>

  // Per-assistant source scoping (denylist). No row = source enabled for the
  // assistant. See docs/architecture/features/knowledge-base.md → "Per-assistant
  // source scoping".
  listDisabledSourceIds(assistantId: string): Promise<string[]>
  setSourceDisabled(params: {
    assistantId: string; sourceId: string; disabled: boolean; userId: string
  }): Promise<void>
}

export function createDbKnowledgeStore(): KnowledgeStore {
  return {
    // ── Entries ──────────────────────────────────────────────

    async search(ctx, queryStr, limit = 10) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const deny = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(5)}` : ''
      const params: unknown[] = [ctx.workspaceId, queryStr, limit, clearance]
      if (appliesDenylist(ctx)) params.push(ctx.assistantId)
      const result = await query<KnowledgeEntry>(
        `SELECT ${entryColumnsClearanceScoped(4)},
                ts_rank_cd(ke.search_vector, plainto_tsquery('english', $2)) AS rank
         FROM knowledge_entries ke
         WHERE ke.workspace_id = $1
           AND ke.search_vector @@ plainto_tsquery('english', $2)
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($4)
           ${deny}
         ORDER BY rank DESC
         LIMIT $3`,
        params,
      )
      return result.rows
    },

    async listByPath(ctx, pathPrefix) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      // List direct children at a path with child counts for directory detection.
      // If pathPrefix is empty, list top-level entries (no '/' in path).
      // Otherwise, list entries whose path starts with pathPrefix/ and has no further '/'.
      if (!pathPrefix) {
        const denyKe = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(3, 'ke')}` : ''
        const denyKe2 = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(3, 'ke2')}` : ''
        const params: unknown[] = [ctx.workspaceId, clearance]
        if (appliesDenylist(ctx)) params.push(ctx.assistantId)
        const result = await query<KnowledgeEntry & { childCount: string }>(
          `SELECT ${entryColumnsClearanceScoped(2)},
                  (SELECT COUNT(*) FROM knowledge_entries ke2
                   WHERE ke2.workspace_id = ke.workspace_id
                     AND ke2.path LIKE ke.path || '/%'
                     AND sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($2)
                     ${denyKe2}) AS "childCount"
           FROM knowledge_entries ke
           WHERE ke.workspace_id = $1 AND ke.path NOT LIKE '%/%'
             AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($2)
             ${denyKe}
           ORDER BY ke.path ASC`,
          params,
        )
        return result.rows.map((r) => ({ ...r, childCount: Number(r.childCount) }))
      }

      const prefix = pathPrefix.replace(/\/+$/, '') + '/'
      const denyKe = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(4, 'ke')}` : ''
      const denyKe2 = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(4, 'ke2')}` : ''
      const childParams: unknown[] = [ctx.workspaceId, prefix, clearance]
      if (appliesDenylist(ctx)) childParams.push(ctx.assistantId)
      const result = await query<KnowledgeEntry & { childCount: string }>(
        `SELECT ${entryColumnsClearanceScoped(3)},
                (SELECT COUNT(*) FROM knowledge_entries ke2
                 WHERE ke2.workspace_id = ke.workspace_id
                   AND ke2.path LIKE ke.path || '/%'
                   AND sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($3)
                   ${denyKe2}) AS "childCount"
         FROM knowledge_entries ke
         WHERE ke.workspace_id = $1
           AND ke.path LIKE $2 || '%'
           AND ke.path NOT LIKE $2 || '%/%'
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($3)
           ${denyKe}
         ORDER BY ke.path ASC`,
        childParams,
      )
      const children = result.rows.map((r) => ({ ...r, childCount: Number(r.childCount) }))
      // Also include the index entry at the pathPrefix itself
      const indexParams: unknown[] = [ctx.workspaceId, pathPrefix.replace(/\/+$/, ''), clearance]
      if (appliesDenylist(ctx)) indexParams.push(ctx.assistantId)
      const indexEntry = await query<KnowledgeEntry>(
        `SELECT ${entryColumnsClearanceScoped(3)} FROM knowledge_entries ke
         WHERE ke.workspace_id = $1 AND ke.path = $2
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($3)
           ${denyKe}`,
        indexParams,
      )
      return [...indexEntry.rows.map((r) => ({ ...r, childCount: 0 })), ...children]
    },

    async getById(ctx, id) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      // Support both full UUID and prefix lookup. Workspace_id scope is
      // applied here too — a viewer in workspace A must not read entries
      // from workspace B even if they guess the ID prefix.
      const deny = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(4)}` : ''
      const params: unknown[] = [id, ctx.workspaceId, clearance]
      if (appliesDenylist(ctx)) params.push(ctx.assistantId)
      const result = await query<KnowledgeEntry>(
        `SELECT ${entryColumnsClearanceScoped(3)} FROM knowledge_entries ke
         WHERE ke.id::text LIKE $1 || '%'
           AND ke.workspace_id = $2
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($3)
           ${deny}
         LIMIT 1`,
        params,
      )
      return result.rows[0] ?? null
    },

    async getByPath(ctx, path) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const deny = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(4)}` : ''
      const params: unknown[] = [ctx.workspaceId, path, clearance]
      if (appliesDenylist(ctx)) params.push(ctx.assistantId)
      const result = await query<KnowledgeEntry>(
        `SELECT ${entryColumnsClearanceScoped(3)} FROM knowledge_entries ke
         WHERE ke.workspace_id = $1 AND ke.path = $2
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($3)
           ${deny}`,
        params,
      )
      return result.rows[0] ?? null
    },

    async getByPathSystem(workspaceId, path) {
      const result = await query<KnowledgeEntry>(
        `SELECT ${ENTRY_COLUMNS} FROM knowledge_entries
         WHERE workspace_id = $1 AND path = $2`,
        [workspaceId, path],
      )
      return result.rows[0] ?? null
    },

    async create(params) {
      const result = await query<KnowledgeEntry>(
        `INSERT INTO knowledge_entries
           (workspace_id, path, title, summary, content, tags, sensitivity, metadata, source_id, source_sha, created_by, compartments)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${ENTRY_COLUMNS}`,
        [
          params.workspaceId, params.path, params.title,
          params.summary ?? null, params.content, params.tags ?? [],
          params.sensitivity, JSON.stringify(params.metadata ?? {}),
          params.sourceId ?? null, params.sourceSha ?? null, params.createdBy ?? null,
          params.compartments ?? [],
        ],
      )
      return result.rows[0]
    },

    async upsertByPath(params) {
      const result = await query<KnowledgeEntry>(
        `INSERT INTO knowledge_entries
           (workspace_id, path, title, summary, content, tags, related_ids, sensitivity, metadata, source_id, source_sha, compartments)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (workspace_id, path) DO UPDATE SET
           title = EXCLUDED.title,
           summary = EXCLUDED.summary,
           content = EXCLUDED.content,
           tags = EXCLUDED.tags,
           related_ids = COALESCE(EXCLUDED.related_ids, knowledge_entries.related_ids),
           sensitivity = EXCLUDED.sensitivity,
           metadata = EXCLUDED.metadata,
           source_id = EXCLUDED.source_id,
           source_sha = EXCLUDED.source_sha,
           compartments = EXCLUDED.compartments
         RETURNING ${ENTRY_COLUMNS}`,
        [
          params.workspaceId, params.path, params.title,
          params.summary ?? null, params.content, params.tags ?? [],
          params.relatedIds ?? [], params.sensitivity, JSON.stringify(params.metadata ?? {}),
          params.sourceId ?? null, params.sourceSha ?? null,
          params.compartments ?? [],
        ],
      )
      return result.rows[0]
    },

    async updateManualEntryContent(workspaceId, id, content) {
      const result = await query<{ id: string; path: string }>(
        `UPDATE knowledge_entries
         SET content = $1, updated_at = now()
         WHERE id = $2 AND workspace_id = $3 AND source_id IS NULL
         RETURNING id, path`,
        [content, id, workspaceId],
      )
      return result.rows[0] ?? null
    },

    async delete(id) {
      const result = await query(
        `DELETE FROM knowledge_entries WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },

    async deleteBySource(sourceId) {
      const result = await query(
        `DELETE FROM knowledge_entries WHERE source_id = $1`,
        [sourceId],
      )
      return result.rowCount ?? 0
    },

    async deleteByTeamAndPath(workspaceId, path) {
      const result = await query(
        `DELETE FROM knowledge_entries WHERE workspace_id = $1 AND path = $2`,
        [workspaceId, path],
      )
      return (result.rowCount ?? 0) > 0
    },

    async deleteByTeamAndPathPrefix(workspaceId, pathPrefix) {
      const result = await query(
        `DELETE FROM knowledge_entries
         WHERE workspace_id = $1 AND path LIKE $2 || '%'`,
        [workspaceId, pathPrefix],
      )
      return result.rowCount ?? 0
    },

    async updateRelatedIds(id, relatedIds) {
      await query(
        `UPDATE knowledge_entries SET related_ids = $1 WHERE id = $2`,
        [relatedIds, id],
      )
    },

    async listSummaries(ctx) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const result = await query<{ id: string; path: string; summary: string | null; sensitivity: Sensitivity }>(
        `SELECT id, path, summary, sensitivity FROM knowledge_entries
         WHERE workspace_id = $1
           AND sensitivity_rank(sensitivity) <= sensitivity_rank($2)
         ORDER BY path ASC`,
        [ctx.workspaceId, clearance],
      )
      return result.rows
    },

    async listForBrain(ctx, queryStr, limit) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const trimmed = queryStr.trim()
      if (trimmed.length === 0) {
        const result = await query<{ id: string; title: string; path: string; sensitivity: Sensitivity }>(
          `SELECT id, title, path, sensitivity FROM knowledge_entries
           WHERE workspace_id = $1
             AND sensitivity_rank(sensitivity) <= sensitivity_rank($2)
           ORDER BY updated_at DESC
           LIMIT $3`,
          [ctx.workspaceId, clearance, limit],
        )
        return result.rows
      }
      const result = await query<{ id: string; title: string; path: string; sensitivity: Sensitivity }>(
        `SELECT id, title, path, sensitivity FROM knowledge_entries
         WHERE workspace_id = $1
           AND search_vector @@ plainto_tsquery('english', $2)
           AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)
         ORDER BY ts_rank_cd(search_vector, plainto_tsquery('english', $2)) DESC
         LIMIT $4`,
        [ctx.workspaceId, trimmed, clearance, limit],
      )
      return result.rows
    },

    async listForGraph(ctx, limit) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const result = await query<{
        id: string
        title: string
        path: string
        sensitivity: Sensitivity
        relatedIds: string[]
      }>(
        `SELECT
           ke.id, ke.title, ke.path, ke.sensitivity,
           COALESCE((
             SELECT array_agg(ke2.id)
             FROM knowledge_entries ke2
             WHERE ke2.id = ANY(ke.related_ids)
               AND ke2.workspace_id = ke.workspace_id
               AND sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($2)
           ), ARRAY[]::uuid[]) AS "relatedIds"
         FROM knowledge_entries ke
         WHERE ke.workspace_id = $1
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($2)
         ORDER BY ke.updated_at DESC
         LIMIT $3`,
        [ctx.workspaceId, clearance, limit],
      )
      return result.rows
    },

    async listByIds(ctx, ids) {
      if (ids.length === 0) return []
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const result = await query<{ id: string; title: string; path: string; sensitivity: Sensitivity }>(
        `SELECT id, title, path, sensitivity FROM knowledge_entries
         WHERE workspace_id = $1
           AND id = ANY($2::uuid[])
           AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)
         ORDER BY path ASC`,
        [ctx.workspaceId, ids, clearance],
      )
      return result.rows
    },

    async listPaths(ctx) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const result = await query<{ path: string }>(
        `SELECT path FROM knowledge_entries
         WHERE workspace_id = $1
           AND sensitivity_rank(sensitivity) <= sensitivity_rank($2)
         ORDER BY path ASC`,
        [ctx.workspaceId, clearance],
      )
      return result.rows.map((r) => r.path)
    },

    async listPathsSystem(workspaceId) {
      const result = await query<{ path: string }>(
        `SELECT path FROM knowledge_entries
         WHERE workspace_id = $1
         ORDER BY path ASC`,
        [workspaceId],
      )
      return result.rows.map((r) => r.path)
    },

    async hasEntries(ctx) {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM knowledge_entries WHERE workspace_id = $1) AS exists`,
        [ctx.workspaceId],
      )
      return result.rows[0]?.exists ?? false
    },

    async hasEntriesForAssistant(assistantId) {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM knowledge_entries ke
           JOIN assistants a ON a.workspace_id = ke.workspace_id
           WHERE a.id = $1
         ) AS exists`,
        [assistantId],
      )
      return result.rows[0]?.exists ?? false
    },

    // ── Sources ─────────────────────────────────────────────

    async createSource(params) {
      const result = await query<KnowledgeSource>(
        `INSERT INTO workspace_knowledge_sources
           (workspace_id, source_type, repo, branch, root_path, connector_instance_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${SOURCE_COLUMNS}`,
        [params.workspaceId, params.sourceType, params.repo, params.branch ?? 'main', params.rootPath ?? '', params.connectorInstanceId ?? null],
      )
      return result.rows[0]
    },

    async getSource(id) {
      const result = await query<KnowledgeSource>(
        `SELECT ${SOURCE_COLUMNS} FROM workspace_knowledge_sources WHERE id = $1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async listSources(workspaceId) {
      const result = await query<KnowledgeSource>(
        `SELECT ${SOURCE_COLUMNS} FROM workspace_knowledge_sources
         WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [workspaceId],
      )
      return result.rows
    },

    async listSourcesForAssistant(assistantId) {
      const result = await query<KnowledgeSource>(
        `SELECT ${SOURCE_COLUMNS} FROM workspace_knowledge_sources
         WHERE workspace_id = (SELECT workspace_id FROM assistants WHERE id = $1)
         ORDER BY created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async deleteSource(id) {
      const result = await query(
        `DELETE FROM workspace_knowledge_sources WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },

    async updateSourceSync(id, sha, error = null) {
      await query(
        `UPDATE workspace_knowledge_sources
         SET last_synced_sha = $1, last_synced_at = now(), sync_error = $2
         WHERE id = $3`,
        [sha, error, id],
      )
    },

    async updateSourceWriteAccess(id, writeAccess) {
      await query(
        `UPDATE workspace_knowledge_sources
         SET write_access = $1, write_access_checked_at = now()
         WHERE id = $2`,
        [writeAccess, id],
      )
    },

    async getSourcesDueForSync() {
      // Return all sources. The caller (sync worker) decides if sync is needed
      // by comparing HEAD SHA with last_synced_sha.
      const result = await query<KnowledgeSource>(
        `SELECT ${SOURCE_COLUMNS}
         FROM workspace_knowledge_sources
         ORDER BY created_at ASC`,
      )
      return result.rows
    },

    // ── Per-assistant source scoping (denylist) ──────────────

    async listDisabledSourceIds(assistantId) {
      const result = await query<{ source_id: string }>(
        `SELECT source_id FROM assistant_disabled_knowledge_sources WHERE assistant_id = $1`,
        [assistantId],
      )
      return result.rows.map((r) => r.source_id)
    },

    async setSourceDisabled({ assistantId, sourceId, disabled, userId }) {
      if (disabled) {
        await query(
          `INSERT INTO assistant_disabled_knowledge_sources (assistant_id, source_id, disabled_by_user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (assistant_id, source_id) DO NOTHING`,
          [assistantId, sourceId, userId],
        )
      } else {
        await query(
          `DELETE FROM assistant_disabled_knowledge_sources WHERE assistant_id = $1 AND source_id = $2`,
          [assistantId, sourceId],
        )
      }
    },
  }
}
