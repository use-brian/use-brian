/**
 * Workspace skill files store — DB-backed analog of Hermes's
 * `references/templates/scripts/` subdirectory layout.
 *
 * Backs the V2 skill auto-generation pointer-expansion contract
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

import { query, queryWithRLS } from './client.js'

export type SkillFileKind = 'reference' | 'template' | 'script'

export type WorkspaceSkillFileRow = {
  id: string
  workspaceSkillId: string
  kind: SkillFileKind
  name: string
  content: string
  description: string | null
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
  /** Insert or update by the (workspaceSkillId, kind, name) UNIQUE. */
  upsert(
    actingUserId: string,
    params: {
      workspaceSkillId: string
      kind: SkillFileKind
      name: string
      content: string
      description?: string | null
    },
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
}

const COLS_PUBLIC = `
  id,
  workspace_skill_id AS "workspaceSkillId",
  kind,
  name,
  content,
  description,
  created_at         AS "createdAt",
  updated_at         AS "updatedAt"
`

export function createDbWorkspaceSkillFilesStore(): WorkspaceSkillFilesStore {
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

    async upsert(actingUserId, params) {
      const r = await queryWithRLS<WorkspaceSkillFileRow>(
        actingUserId,
        `INSERT INTO workspace_skill_files (workspace_skill_id, kind, name, content, description)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_skill_id, kind, name) DO UPDATE
           SET content = EXCLUDED.content,
               description = EXCLUDED.description,
               updated_at = now()
         RETURNING ${COLS_PUBLIC}`,
        [
          params.workspaceSkillId,
          params.kind,
          params.name,
          params.content,
          params.description ?? null,
        ],
      )
      return r.rows[0]
    },

    async delete(actingUserId, workspaceSkillId, kind, name) {
      const r = await queryWithRLS(
        actingUserId,
        `DELETE FROM workspace_skill_files
         WHERE workspace_skill_id = $1 AND kind = $2 AND name = $3`,
        [workspaceSkillId, kind, name],
      )
      return (r.rowCount ?? 0) > 0
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
  }
}
