/**
 * Workspace skill files store — path-preserving materialization of native
 * `references/assets/scripts/` bundle directories (`templates/` is legacy).
 *
 * Backs native exact-path resource reads/search plus the legacy pointer contract
 * (`docs/architecture/engine/skill-system.md` §S10 — curator
 * `DEMOTE_TO_REFERENCES` move; §S14 — auto-gen body authoring). A skill
 * body referencing `templates/weekly-status.md` looks up the file via
 * `getByPointer({ kind: 'template', name: 'weekly-status.md' })`.
 *
 * RLS is delegated to the parent `workspace_skills` row's workspace_id
 * via the mig 169 policy — there is no per-row user/workspace column.
 *
 * [COMP:api/workspace-skill-files-store]
 */

import { normalizeSkillResourcePath, sha256, skillResourceKindFromPath } from '@use-brian/core'
import { query, queryWithRLS } from './client.js'

export type SkillFileKind = 'reference' | 'asset' | 'template' | 'script'

export type WorkspaceSkillFileRow = {
  id: string
  workspaceSkillId: string
  kind: SkillFileKind
  name: string
  path: string | null
  content: string
  description: string | null
  contentHash: string | null
  createdAt: Date
  updatedAt: Date
}

export type WorkspaceSkillFilesStore = {
  /** Every file attached to a skill, ordered by kind then name. */
  list(workspaceSkillId: string, opts?: { actingUserId?: string }): Promise<WorkspaceSkillFileRow[]>
  /** Single file by (workspaceSkillId, kind, name). The loader pointer-expansion lookup. */
  getByPointer(
    workspaceSkillId: string,
    pointer: { kind: SkillFileKind; name: string },
    opts?: { actingUserId?: string },
  ): Promise<WorkspaceSkillFileRow | null>
  /** Native bundle lookup by exact root-relative path. */
  getByPath(
    workspaceSkillId: string,
    path: string,
    opts?: { actingUserId?: string },
  ): Promise<WorkspaceSkillFileRow | null>
  /** Insert or update by the (workspaceSkillId, kind, name) UNIQUE. */
  upsert(
    actingUserId: string,
    params: {
      workspaceSkillId: string
      kind: SkillFileKind
      name: string
      path?: string | null
      content: string
      description?: string | null
      contentHash?: string | null
    },
    opts?: { notify?: boolean },
  ): Promise<WorkspaceSkillFileRow>
  delete(
    actingUserId: string,
    workspaceSkillId: string,
    kind: SkillFileKind,
    name: string,
  ): Promise<boolean>
  listByKind(
    workspaceSkillId: string,
    kind: SkillFileKind,
    opts?: { actingUserId?: string },
  ): Promise<WorkspaceSkillFileRow[]>
  /** Bulk resource hydration for runtime injection / graph projection. */
  listForSkills(
    workspaceSkillIds: readonly string[],
    opts?: { actingUserId?: string },
  ): Promise<WorkspaceSkillFileRow[]>
  search(
    workspaceSkillId: string,
    searchQuery: string,
    limit?: number,
    opts?: { actingUserId?: string },
  ): Promise<WorkspaceSkillFileRow[]>
  /** Fire the graph lifecycle hook once after a deferred batch is complete. */
  notifyChanged(workspaceSkillId: string, retiredResourceIds?: readonly string[]): void
}

export type WorkspaceSkillFilesStoreHooks = {
  /** Fires after a resource write or delete so derived graph edges self-heal. */
  onChanged?: (workspaceSkillId: string, retiredResourceIds?: readonly string[]) => void
}

const COLS_PUBLIC = `
  id,
  workspace_skill_id AS "workspaceSkillId",
  kind,
  name,
  path,
  content,
  description,
  content_hash       AS "contentHash",
  created_at         AS "createdAt",
  updated_at         AS "updatedAt"
`

function defaultPath(kind: SkillFileKind, name: string): string {
  const normalizedName = normalizeSkillResourcePath(name)
  if (normalizedName && skillResourceKindFromPath(normalizedName)) return normalizedName
  const root = kind === 'reference' ? 'references' : kind === 'asset' ? 'assets' : kind === 'template' ? 'templates' : 'scripts'
  return `${root}/${name}`
}

export function createDbWorkspaceSkillFilesStore(
  hooks: WorkspaceSkillFilesStoreHooks = {},
): WorkspaceSkillFilesStore {
  return {
    async list(workspaceSkillId, opts) {
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_files
        WHERE workspace_skill_id = $1
        ORDER BY kind ASC, name ASC
      `
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillFileRow>(opts.actingUserId, sql, [
          workspaceSkillId,
        ])
        return r.rows
      }
      const r = await query<WorkspaceSkillFileRow>(sql, [workspaceSkillId])
      return r.rows
    },

    async getByPointer(workspaceSkillId, pointer, opts) {
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_files
        WHERE workspace_skill_id = $1 AND kind = $2 AND name = $3
        LIMIT 1
      `
      const params = [workspaceSkillId, pointer.kind, pointer.name]
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillFileRow>(opts.actingUserId, sql, params)
        return r.rows[0] ?? null
      }
      const r = await query<WorkspaceSkillFileRow>(sql, params)
      return r.rows[0] ?? null
    },

    async getByPath(workspaceSkillId, path, opts) {
      const normalized = normalizeSkillResourcePath(path)
      if (!normalized) return null
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_files
        WHERE workspace_skill_id = $1 AND path = $2
        LIMIT 1
      `
      const params = [workspaceSkillId, normalized]
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillFileRow>(opts.actingUserId, sql, params)
        return r.rows[0] ?? null
      }
      const r = await query<WorkspaceSkillFileRow>(sql, params)
      return r.rows[0] ?? null
    },

    async upsert(actingUserId, params, opts) {
      const r = await queryWithRLS<WorkspaceSkillFileRow>(
        actingUserId,
        `INSERT INTO workspace_skill_files (
           workspace_skill_id, kind, name, path, content, description, content_hash
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_skill_id, kind, name) DO UPDATE
           SET content = EXCLUDED.content,
               path = EXCLUDED.path,
               description = EXCLUDED.description,
               content_hash = EXCLUDED.content_hash,
               updated_at = now()
         RETURNING ${COLS_PUBLIC}`,
        [
          params.workspaceSkillId,
          params.kind,
          params.name,
          params.path ?? defaultPath(params.kind, params.name),
          params.content,
          params.description ?? null,
          params.contentHash ?? sha256(params.content),
        ],
      )
      const row = r.rows[0]
      if (row && opts?.notify !== false) {
        try { hooks.onChanged?.(row.workspaceSkillId) } catch { /* best-effort graph hook */ }
      }
      return row
    },

    async delete(actingUserId, workspaceSkillId, kind, name) {
      const r = await queryWithRLS<{ id: string }>(
        actingUserId,
        `DELETE FROM workspace_skill_files
         WHERE workspace_skill_id = $1 AND kind = $2 AND name = $3
         RETURNING id`,
        [workspaceSkillId, kind, name],
      )
      const retiredId = r.rows[0]?.id
      if (retiredId) {
        try { hooks.onChanged?.(workspaceSkillId, [retiredId]) } catch { /* best-effort graph hook */ }
      }
      return Boolean(retiredId)
    },

    async listByKind(workspaceSkillId, kind, opts) {
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_files
        WHERE workspace_skill_id = $1 AND kind = $2
        ORDER BY name ASC
      `
      const params = [workspaceSkillId, kind]
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillFileRow>(opts.actingUserId, sql, params)
        return r.rows
      }
      const r = await query<WorkspaceSkillFileRow>(sql, params)
      return r.rows
    },

    async listForSkills(workspaceSkillIds, opts) {
      if (workspaceSkillIds.length === 0) return []
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_files
        WHERE workspace_skill_id = ANY($1::uuid[])
        ORDER BY workspace_skill_id ASC, path ASC NULLS LAST, kind ASC, name ASC
      `
      const params = [workspaceSkillIds]
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillFileRow>(opts.actingUserId, sql, params)
        return r.rows
      }
      const r = await query<WorkspaceSkillFileRow>(sql, params)
      return r.rows
    },

    async search(workspaceSkillId, searchQuery, limit = 5, opts) {
      const bounded = Math.max(1, Math.min(limit, 10))
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_files
        WHERE workspace_skill_id = $1
          AND search_vector @@ plainto_tsquery('simple', $2)
        ORDER BY ts_rank(search_vector, plainto_tsquery('simple', $2)) DESC,
                 path ASC NULLS LAST
        LIMIT $3
      `
      const params = [workspaceSkillId, searchQuery, bounded]
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillFileRow>(opts.actingUserId, sql, params)
        return r.rows
      }
      const r = await query<WorkspaceSkillFileRow>(sql, params)
      return r.rows
    },

    notifyChanged(workspaceSkillId, retiredResourceIds) {
      try { hooks.onChanged?.(workspaceSkillId, retiredResourceIds) } catch { /* best-effort graph hook */ }
    },
  }
}
