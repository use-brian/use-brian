/**
 * DB-backed logic-block store — the open impl of core's `BrowserSkillStore`
 * port over `browser_skills` (migration 319). Blocks are code artifacts in
 * brain (R2-9): Python driving the governed runner, versioned, carrying their
 * R2-5 review artifacts (effect contract + authoring recording), site-scoped
 * and identity-agnostic (R2-10).
 *
 * [COMP:sandbox/logic-block]
 */
import type {
  BrowserSkill,
  BrowserSkillContract,
  BrowserSkillRecordingStep,
  BrowserSkillStore,
  CreateBrowserSkillParams,
} from '@sidanclaw/core'
import { query } from './client.js'

type Row = {
  id: string
  workspace_id: string
  name: string
  site: string
  description: string
  code: string
  params_schema: Record<string, unknown>
  contract: BrowserSkillContract
  recording: BrowserSkillRecordingStep[]
  version: number
  origin: 'self_heal' | 'assistant' | 'external'
  created_by: string | null
  status: 'active' | 'archived'
  created_at: Date
  updated_at: Date
}

function toSkill(row: Row): BrowserSkill {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    site: row.site,
    description: row.description,
    code: row.code,
    paramsSchema: row.params_schema ?? {},
    contract: row.contract,
    recording: row.recording ?? [],
    version: row.version,
    origin: row.origin,
    createdBy: row.created_by,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function createBrowserSkillsStore(): BrowserSkillStore {
  return {
    async get(id) {
      const res = await query<Row>(`SELECT * FROM browser_skills WHERE id = $1`, [id])
      return res.rows[0] ? toSkill(res.rows[0]) : null
    },

    async getByName({ workspaceId, name }) {
      const res = await query<Row>(
        `SELECT * FROM browser_skills WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, name],
      )
      return res.rows[0] ? toSkill(res.rows[0]) : null
    },

    async list({ workspaceId, site }) {
      const res = site
        ? await query<Row>(
            `SELECT * FROM browser_skills WHERE workspace_id = $1 AND site = $2 ORDER BY created_at`,
            [workspaceId, site],
          )
        : await query<Row>(
            `SELECT * FROM browser_skills WHERE workspace_id = $1 ORDER BY created_at`,
            [workspaceId],
          )
      return res.rows.map(toSkill)
    },

    async create(params: CreateBrowserSkillParams) {
      const res = await query<Row>(
        `INSERT INTO browser_skills
           (workspace_id, name, site, description, code, params_schema, contract, recording, origin, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          params.workspaceId,
          params.name,
          params.site,
          params.description ?? '',
          params.code,
          JSON.stringify(params.paramsSchema ?? {}),
          JSON.stringify(params.contract),
          JSON.stringify(params.recording ?? []),
          params.origin,
          params.createdBy ?? null,
        ],
      )
      return toSkill(res.rows[0])
    },

    async update(id, patch) {
      const sets: string[] = []
      const values: unknown[] = [id]
      const push = (sql: string, value: unknown) => {
        values.push(value)
        sets.push(`${sql} = $${values.length}`)
      }
      if (patch.description !== undefined) push('description', patch.description)
      if (patch.code !== undefined) push('code', patch.code)
      if (patch.paramsSchema !== undefined) push('params_schema', JSON.stringify(patch.paramsSchema))
      if (patch.contract !== undefined) push('contract', JSON.stringify(patch.contract))
      if (patch.recording !== undefined) push('recording', JSON.stringify(patch.recording))
      if (patch.status !== undefined) push('status', patch.status)
      if (sets.length === 0) {
        const res = await query<Row>(`SELECT * FROM browser_skills WHERE id = $1`, [id])
        return res.rows[0] ? toSkill(res.rows[0]) : null
      }
      sets.push('version = version + 1', 'updated_at = now()')
      const res = await query<Row>(
        `UPDATE browser_skills SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      )
      return res.rows[0] ? toSkill(res.rows[0]) : null
    },
  }
}
