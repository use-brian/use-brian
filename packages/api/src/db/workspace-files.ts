import { randomUUID } from 'node:crypto'
import type {
  AccessContext,
  EntityLinksStore,
  FileSensitivity,
  WorkspaceFile,
  WorkspaceFileCreateInput,
  WorkspaceFileIndexRow,
  WorkspaceFileMetaPatch,
  WorkspaceFileSupersedePatch,
} from '@sidanclaw/core'
import { buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'
import { emitDocumentedByEdges } from './edge-hooks.js'

const FULL_SELECT = `
  id, workspace_id as "workspaceId", path, parent_path as "parentPath",
  name, title, summary, mime, size_bytes as "sizeBytes",
  tags, related_ids as "relatedIds", storage_uri as "storageUri",
  sensitivity, metadata,
  user_id as "userId", assistant_id as "assistantId",
  source, source_episode_id as "sourceEpisodeId",
  verified_by_user_id as "verifiedByUserId", verified_at as "verifiedAt",
  valid_from as "validFrom", valid_to as "validTo",
  superseded_by as "supersededBy",
  retracted_at as "retractedAt", retracted_reason as "retractedReason",
  retracted_by as "retractedBy",
  created_by_user_id as "createdByUserId",
  created_by_assistant_id as "createdByAssistantId",
  created_at as "createdAt", updated_at as "updatedAt"
`

const INDEX_SELECT = `
  id, workspace_id as "workspaceId", path, parent_path as "parentPath",
  name, title, summary, mime, size_bytes as "sizeBytes",
  tags, sensitivity, updated_at as "updatedAt"
`

type FileRow = {
  id: string
  workspaceId: string
  path: string
  parentPath: string
  name: string
  title: string | null
  summary: string | null
  mime: string
  sizeBytes: number | string
  tags: string[]
  relatedIds: string[]
  storageUri: string
  sensitivity: FileSensitivity
  metadata: Record<string, unknown> | null
  userId: string | null
  assistantId: string | null
  source: string
  sourceEpisodeId: string | null
  verifiedByUserId: string | null
  verifiedAt: Date | null
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  retractedAt: Date | null
  retractedReason: string | null
  retractedBy: string | null
  createdByUserId: string | null
  createdByAssistantId: string | null
  createdAt: Date
  updatedAt: Date
}

type IndexRow = {
  id: string
  workspaceId: string
  path: string
  parentPath: string
  name: string
  title: string | null
  summary: string | null
  mime: string
  sizeBytes: number | string
  tags: string[]
  sensitivity: FileSensitivity
  updatedAt: Date
}

/** Postgres BIGINT comes back as string in pg's default settings; coerce. */
function asNumber(v: number | string): number {
  return typeof v === 'string' ? Number(v) : v
}

function toRecord(row: FileRow): WorkspaceFile {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    title: row.title,
    summary: row.summary,
    mime: row.mime,
    sizeBytes: asNumber(row.sizeBytes),
    tags: row.tags,
    relatedIds: row.relatedIds,
    storageUri: row.storageUri,
    sensitivity: row.sensitivity,
    metadata: row.metadata ?? {},
    userId: row.userId,
    assistantId: row.assistantId,
    source: row.source,
    sourceEpisodeId: row.sourceEpisodeId,
    verifiedByUserId: row.verifiedByUserId,
    verifiedAt: row.verifiedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    supersededBy: row.supersededBy,
    retractedAt: row.retractedAt,
    retractedReason: row.retractedReason,
    retractedBy: row.retractedBy,
    createdByUserId: row.createdByUserId,
    createdByAssistantId: row.createdByAssistantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toIndexRow(row: IndexRow): WorkspaceFileIndexRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    title: row.title,
    summary: row.summary,
    mime: row.mime,
    sizeBytes: asNumber(row.sizeBytes),
    tags: row.tags,
    sensitivity: row.sensitivity,
    updatedAt: row.updatedAt,
  }
}

/**
 * Create a workspace file.
 *
 * WU-1.7 edge hook: when `opts.documentsEntityIds` is non-empty AND an
 * `opts.entityLinks` store is passed, an `entity → file` `documented_by`
 * edge is emitted per entity id, fire-and-forget, after the file row is
 * written. Edge failures never affect the file save (see
 * `edge-hooks.ts`). `opts` is optional so existing call sites keep
 * compiling unchanged. The `documents...` data rides a separate `opts`
 * arg rather than `WorkspaceFileCreateInput` because that input type is
 * a `@sidanclaw/core` contract — widening it is a follow-up.
 */
export async function createWorkspaceFile(
  userId: string,
  input: WorkspaceFileCreateInput,
  opts: {
    entityLinks?: EntityLinksStore
    /** Entity ids this file documents — each gets a `documented_by`
     *  edge (WU-1.7). Optional; empty/absent means no edge emission. */
    documentsEntityIds?: readonly string[]
    /** Commit SHA provenance, stored in the edge's `attributes` JSONB. */
    commitSha?: string
  } = {},
): Promise<WorkspaceFile> {
  // WU-4.5 — `input.createdByUserId` is the row author (separate from
  // the `userId` arg which is the RLS actor; they are usually equal
  // but the row-author identity is what gets stamped). Reject the
  // insert if it would land NULL — mig 128 leaves the column nullable
  // for legacy rows, so the guard, not the schema, enforces.
  assertAuthorshipPresent('createWorkspaceFile', input.createdByUserId)
  // When the caller supplies an id (the files-api does, so the GCS key
  // and DB row share the same uuid), use it; otherwise let the DB
  // default `gen_random_uuid()` fire.
  const cols: string[] = [
    'workspace_id', 'path', 'parent_path', 'name', 'title', 'summary',
    'mime', 'size_bytes', 'tags', 'related_ids', 'storage_uri',
    'sensitivity', 'metadata',
    'user_id', 'assistant_id', 'source', 'source_episode_id',
    'created_by_user_id', 'created_by_assistant_id', 'compartments',
  ]
  const values: unknown[] = [
    input.workspaceId,
    input.path,
    input.parentPath,
    input.name,
    input.title ?? null,
    input.summary ?? null,
    input.mime,
    input.sizeBytes,
    input.tags ?? [],
    input.relatedIds ?? [],
    input.storageUri,
    input.sensitivity ?? 'internal',
    JSON.stringify(input.metadata ?? {}),
    input.userId ?? null,
    input.assistantId ?? null,
    input.source ?? 'user',
    input.sourceEpisodeId ?? null,
    input.createdByUserId,
    input.createdByAssistantId ?? null,
    input.compartments ?? [],
  ]
  if (input.id) {
    cols.unshift('id')
    values.unshift(input.id)
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
  const result = await queryWithRLS<FileRow>(
    userId,
    `INSERT INTO workspace_files (${cols.join(', ')})
     VALUES (${placeholders})
     RETURNING ${FULL_SELECT}`,
    values,
  )
  const file = toRecord(result.rows[0])

  // Fire-and-forget `documented_by` edges (entity → file) — `void`,
  // never awaited on the caller's path, never able to throw into the
  // file save.
  if (opts.entityLinks && opts.documentsEntityIds && opts.documentsEntityIds.length > 0) {
    // Edge trust source mirrors the file's: pipeline-extracted files
    // yield an `'extracted'` edge, everything else `'user'` (file
    // `source` is a free `string`, normalized here to `EntitySource`).
    const edgeSource = file.source === 'extracted' ? 'extracted' : 'user'
    void emitDocumentedByEdges(opts.entityLinks, userId, {
      fileId: file.id,
      entityIds: opts.documentsEntityIds,
      workspaceId: file.workspaceId,
      source: edgeSource,
      userId: file.userId,
      assistantId: file.assistantId,
      sourceEpisodeId: file.sourceEpisodeId,
      commitSha: opts.commitSha,
    })
  }
  return file
}

export async function getWorkspaceFileById(
  ctx: AccessContext,
  id: string,
): Promise<WorkspaceFile | null> {
  // Universal access projection (WU-4.2b) + `valid_to IS NULL` to hide
  // superseded versions; history reachable via `getWorkspaceFileHistory`.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<FileRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM workspace_files
     WHERE ${ap.sql}
       AND id = $${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params, id],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

export async function getWorkspaceFileByPath(
  ctx: AccessContext,
  path: string,
): Promise<WorkspaceFile | null> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<FileRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM workspace_files
     WHERE ${ap.sql}
       AND path = $${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params, path],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

export async function updateWorkspaceFileMeta(
  userId: string,
  workspaceId: string,
  id: string,
  patch: WorkspaceFileMetaPatch,
): Promise<WorkspaceFile | null> {
  // Metadata-only edits stay in-place per corrections.md §D.7 — only
  // content (substantive) edits route through `supersedeWorkspaceFile`.
  // The lock-in side of the draft lifecycle (remove `'draft'`, add
  // `'final'`) is a tags patch, which lands here.
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (patch.title !== undefined)       { sets.push(`title = $${idx}`);       values.push(patch.title);       idx++ }
  if (patch.summary !== undefined)     { sets.push(`summary = $${idx}`);     values.push(patch.summary);     idx++ }
  if (patch.tags !== undefined)        { sets.push(`tags = $${idx}`);        values.push(patch.tags);        idx++ }
  if (patch.relatedIds !== undefined)  { sets.push(`related_ids = $${idx}`); values.push(patch.relatedIds);  idx++ }
  if (patch.sensitivity !== undefined) { sets.push(`sensitivity = $${idx}`); values.push(patch.sensitivity); idx++ }
  if (patch.metadata !== undefined)    { sets.push(`metadata = $${idx}`);    values.push(JSON.stringify(patch.metadata)); idx++ }

  if (sets.length === 0) {
    // No-op short-circuit — read the current row through the write
    // path's RLS-only gate (this is the write surface; per-viewer
    // projection lives on the read entrypoint).
    const cur = await queryWithRLS<FileRow>(
      userId,
      `SELECT ${FULL_SELECT} FROM workspace_files
       WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL`,
      [id, workspaceId],
    )
    return cur.rows.length === 0 ? null : toRecord(cur.rows[0])
  }

  values.push(id, workspaceId)
  const result = await queryWithRLS<FileRow>(
    userId,
    `UPDATE workspace_files SET ${sets.join(', ')}
     WHERE id = $${idx} AND workspace_id = $${idx + 1} AND valid_to IS NULL
     RETURNING ${FULL_SELECT}`,
    values,
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

export async function updateWorkspaceFileSize(
  userId: string,
  workspaceId: string,
  id: string,
  sizeBytes: number,
): Promise<WorkspaceFile | null> {
  // `append` calls this. Size drift is a content edit but the existing
  // files-api semantics treat append as an in-place bump on the current
  // row, not a supersession. The `staged_write` approval flow is the
  // explicit supersession driver.
  const result = await queryWithRLS<FileRow>(
    userId,
    `UPDATE workspace_files SET size_bytes = $1
     WHERE id = $2 AND workspace_id = $3 AND valid_to IS NULL
     RETURNING ${FULL_SELECT}`,
    [sizeBytes, id, workspaceId],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

export async function deleteWorkspaceFile(
  userId: string,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  // Hard-deletes the current row. WU-6 (D.3 retraction) introduces the
  // soft-delete path; for now `delete` clears both the DB row and (via
  // files-api) the GCS blob, matching pre-WS-2 semantics.
  const result = await queryWithRLS<{ id: string }>(
    userId,
    `DELETE FROM workspace_files
     WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL
     RETURNING id`,
    [id, workspaceId],
  )
  return result.rows.length > 0
}

export async function retractWorkspaceFilesByStorageBucket(
  workspaceId: string,
  bucket: string,
  reason: string,
): Promise<number> {
  // System-level (no RLS) — invoked by the BYO storage staleness sweep when a
  // disconnected binding's bucket goes stale and its key is wiped. Soft-retracts
  // every current row whose bytes live in `bucket` (now unreadable), closing the
  // bi-temporal window so all current-version queries (search, L1, getById /
  // getByPath, sumSize) stop surfacing them. Audit history is preserved.
  // `^@` is the prefix operator (no LIKE wildcard interpretation of the bucket).
  const result = await query(
    `UPDATE workspace_files
        SET valid_to = now(), retracted_at = now(), retracted_reason = $3
      WHERE workspace_id = $1
        AND storage_uri ^@ $2
        AND valid_to IS NULL
        AND retracted_at IS NULL`,
    [workspaceId, `gs://${bucket}/`, reason],
  )
  return result.rowCount ?? 0
}

export async function listWorkspaceFilesByPath(
  ctx: AccessContext,
  opts: { prefix?: string; limit?: number; offset?: number },
): Promise<WorkspaceFileIndexRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const prefix = opts.prefix ?? ''
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<IndexRow>(
    ctx.userId,
    `SELECT ${INDEX_SELECT} FROM workspace_files
     WHERE ${ap.sql}
       AND parent_path = $${ap.nextIdx} AND valid_to IS NULL
     ORDER BY updated_at DESC
     LIMIT $${ap.nextIdx + 1} OFFSET $${ap.nextIdx + 2}`,
    [...ap.params, prefix, limit, offset],
  )
  return result.rows.map(toIndexRow)
}

export async function searchWorkspaceFiles(
  ctx: AccessContext,
  opts: { query?: string; tag?: string; parentPath?: string; limit?: number },
): Promise<WorkspaceFileIndexRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  // Doc-block media lives under the reserved `/doc/` path prefix
  // (see packages/api/src/routes/doc-files.ts). It is durable storage
  // but is deliberately EXCLUDED from `fileSearch` so high-volume
  // decorative paste/drop content does not pollute brain retrieval.
  const wheres: string[] = [ap.sql, 'valid_to IS NULL', "path NOT LIKE '/doc/%'"]
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx
  let orderBy = 'updated_at DESC'

  if (opts.query && opts.query.trim().length > 0) {
    wheres.push(`search_vector @@ plainto_tsquery('english', $${idx})`)
    values.push(opts.query)
    orderBy = `ts_rank_cd(search_vector, plainto_tsquery('english', $${idx})) DESC`
    idx++
  }
  if (opts.tag) {
    wheres.push(`$${idx} = ANY(tags)`)
    values.push(opts.tag)
    idx++
  }
  if (opts.parentPath !== undefined) {
    wheres.push(`parent_path = $${idx}`)
    values.push(opts.parentPath)
    idx++
  }

  values.push(limit)
  const result = await queryWithRLS<IndexRow>(
    ctx.userId,
    `SELECT ${INDEX_SELECT} FROM workspace_files
     WHERE ${wheres.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toIndexRow)
}

export async function listWorkspaceFilesIndexRanked(
  ctx: AccessContext,
  limit: number,
): Promise<WorkspaceFileIndexRow[]> {
  const cap = Math.min(Math.max(limit, 1), 200)
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  // Doc-block media (reserved `/doc/` path prefix — see
  // packages/api/src/routes/doc-files.ts) is excluded from the ranked
  // index that backs the L1 `# Workspace Files` prompt block, so embedded
  // page decoration never surfaces in the assistant's working context.
  const result = await queryWithRLS<IndexRow>(
    ctx.userId,
    `SELECT ${INDEX_SELECT} FROM workspace_files
     WHERE ${ap.sql} AND valid_to IS NULL AND path NOT LIKE '/doc/%'
     ORDER BY updated_at DESC
     LIMIT $${ap.nextIdx}`,
    [...ap.params, cap],
  )
  return result.rows.map(toIndexRow)
}

export async function sumWorkspaceFilesSizeBytes(
  ctx: AccessContext,
): Promise<number> {
  // Historical (superseded) rows are excluded from the quota — their
  // GCS blobs may linger until retraction sweeps, but the current
  // active rows are what the quota gates against.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<{ total: number | string | null }>(
    ctx.userId,
    `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
     FROM workspace_files
     WHERE ${ap.sql} AND valid_to IS NULL`,
    [...ap.params],
  )
  const total = result.rows[0]?.total ?? 0
  return typeof total === 'string' ? Number(total) : total
}

/**
 * Atomic supersession (SV(2)). Closes the current row's bi-temporal
 * window and inserts a successor in a single transaction so neither
 * write lands without the other. RLS is engaged for the duration of
 * the transaction.
 *
 * NOTE: The legacy `UNIQUE (workspace_id, path)` constraint from mig
 * 119 blocks path-stable supersession — the old row still owns the
 * path until physically removed, so an INSERT with the same path
 * violates the constraint. A follow-up migration must relax this to
 * `UNIQUE (workspace_id, path) WHERE valid_to IS NULL`. Until then,
 * supersession only works when the patch changes the path or the
 * legacy row is independently moved aside.
 */
export async function supersedeWorkspaceFile(
  userId: string,
  workspaceId: string,
  id: string,
  patch: WorkspaceFileSupersedePatch,
): Promise<WorkspaceFile | null> {
  const client = await getAppPool().connect()
  try {
    // Runs on the app pool (app_user, subject to RLS). `BEGIN` first, then
    // `SET LOCAL app.current_user_id` so it reverts at COMMIT/ROLLBACK to the
    // seeded sentinel and never leaks onto the pooled connection.
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)

    const current = await client.query<FileRow>(
      `SELECT ${FULL_SELECT} FROM workspace_files
       WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL
       FOR UPDATE`,
      [id, workspaceId],
    )

    if (current.rows.length === 0) {
      await client.query('ROLLBACK')
      return null
    }

    const old = current.rows[0]
    const newId = randomUUID()

    await client.query(
      `UPDATE workspace_files
          SET valid_to = now(),
              superseded_by = $1
        WHERE id = $2 AND workspace_id = $3`,
      [newId, id, workspaceId],
    )

    const inserted = await client.query<FileRow>(
      `INSERT INTO workspace_files (
         id, workspace_id, path, parent_path, name, title, summary,
         mime, size_bytes, tags, related_ids, storage_uri,
         sensitivity, metadata,
         user_id, assistant_id, source, source_episode_id,
         valid_from, created_by_user_id, created_by_assistant_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14,
         $15, $16, $17, $18,
         now(), $19, $20
       )
       RETURNING ${FULL_SELECT}`,
      [
        newId,
        workspaceId,
        patch.path ?? old.path,
        patch.parentPath ?? old.parentPath,
        patch.name ?? old.name,
        patch.title !== undefined ? patch.title : old.title,
        patch.summary !== undefined ? patch.summary : old.summary,
        patch.mime ?? old.mime,
        patch.sizeBytes,
        patch.tags ?? old.tags,
        patch.relatedIds ?? old.relatedIds,
        patch.storageUri,
        patch.sensitivity ?? old.sensitivity,
        JSON.stringify(patch.metadata ?? old.metadata ?? {}),
        old.userId,
        old.assistantId,
        old.source,
        old.sourceEpisodeId,
        patch.editorUserId,
        patch.editorAssistantId ?? null,
      ],
    )

    await client.query('COMMIT')
    return toRecord(inserted.rows[0])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await rollbackAndRelease(client)
  }
}

/**
 * D.7 audit walk — every version of this row's supersession chain,
 * ordered oldest → newest by `valid_from`. The recursive CTE accepts
 * any id within the chain; results converge to the same set whether
 * the caller passed the head, tail, or a middle version (the anchor
 * starts at the passed id, then walks both backward via `superseded_by`
 * and forward via the inverse).
 */
export async function getWorkspaceFileHistory(
  ctx: AccessContext,
  id: string,
): Promise<WorkspaceFile[]> {
  // Recursive CTE walks both directions of the supersession chain from
  // any starting id — `superseded_by` (forward) and the inverse
  // (backward). Postgres' WITH RECURSIVE allows exactly one recursive
  // term, so the bidirectional walk is fused into a single OR clause.
  // The CTE projects only `id` because `workspace_files` carries a
  // TSVECTOR column (`search_vector`) which has no equality operator
  // and so cannot participate in `UNION` deduplication — the full row
  // is read in the outer SELECT.
  //
  // D.7 invariant: chain rows share the universal-column tuple, so the
  // access predicate gates the anchor only (WU-4.2b).
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const idIdx = ap.nextIdx
  const result = await queryWithRLS<FileRow>(
    ctx.userId,
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by FROM workspace_files
         WHERE ${ap.sql} AND id = $${idIdx}
       UNION
       SELECT wf.id, wf.superseded_by
         FROM workspace_files wf, chain c
         WHERE wf.workspace_id = $1
           AND (wf.id = c.superseded_by OR wf.superseded_by = c.id)
     )
     SELECT ${FULL_SELECT} FROM workspace_files
       WHERE workspace_id = $1 AND id IN (SELECT id FROM chain)
       ORDER BY valid_from ASC, created_at ASC`,
    [...ap.params, id],
  )
  return result.rows.map(toRecord)
}
