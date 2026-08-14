/**
 * DB-backed browser-profile store over `browser_profiles`.
 *
 * [COMP:sandbox/profiles]
 */
import type {
  BrowserProfile,
  BrowserProfileStore,
  CreateBrowserProfileParams,
  UpdateBrowserProfileParams,
} from '@use-brian/core'
import { query } from './client.js'

type Row = {
  id: string
  workspace_id: string
  owner_user_id: string
  name: string
  clearance: 'public' | 'internal' | 'confidential'
  enabled_assistant_ids: string[]
  assistant_routing_notes: Record<string, string>
  default_backend: 'local' | 'cloud'
  local_control_mode: 'task_tabs' | 'full_browser'
  proxy_url: string | null
  created_at: Date
  updated_at: Date
}

function toProfile(row: Row): BrowserProfile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    clearance: row.clearance,
    enabledAssistantIds: row.enabled_assistant_ids ?? [],
    assistantRoutingNotes: row.assistant_routing_notes ?? {},
    defaultBackend: row.default_backend,
    localControlMode: row.local_control_mode,
    proxyUrl: row.proxy_url,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function createBrowserProfileStore(): BrowserProfileStore {
  return {
    async get(id) {
      const res = await query<Row>(`SELECT * FROM browser_profiles WHERE id = $1`, [id])
      return res.rows[0] ? toProfile(res.rows[0]) : null
    },

    async getByName({ workspaceId, name }) {
      const res = await query<Row>(
        `SELECT * FROM browser_profiles WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, name],
      )
      return res.rows[0] ? toProfile(res.rows[0]) : null
    },

    async list({ workspaceId }) {
      const res = await query<Row>(
        `SELECT * FROM browser_profiles WHERE workspace_id = $1 ORDER BY created_at`,
        [workspaceId],
      )
      return res.rows.map(toProfile)
    },

    async create(params: CreateBrowserProfileParams) {
      const res = await query<Row>(
        `INSERT INTO browser_profiles
           (workspace_id, owner_user_id, name, clearance, enabled_assistant_ids,
            assistant_routing_notes, default_backend, local_control_mode, proxy_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          params.workspaceId,
          params.ownerUserId,
          params.name,
          params.clearance ?? 'confidential',
          params.enabledAssistantIds ?? [],
          params.assistantRoutingNotes ?? {},
          params.defaultBackend ?? 'cloud',
          params.localControlMode ?? 'task_tabs',
          params.proxyUrl ?? null,
        ],
      )
      return toProfile(res.rows[0])
    },

    async update(id, patch: UpdateBrowserProfileParams) {
      const sets: string[] = []
      const params: unknown[] = [id]
      const push = (sql: string, value: unknown) => {
        params.push(value)
        sets.push(`${sql} = $${params.length}`)
      }
      if (patch.name !== undefined) push('name', patch.name)
      if (patch.clearance !== undefined) push('clearance', patch.clearance)
      if (patch.defaultBackend !== undefined) push('default_backend', patch.defaultBackend)
      if (patch.localControlMode !== undefined) push('local_control_mode', patch.localControlMode)
      if (patch.proxyUrl !== undefined) push('proxy_url', patch.proxyUrl)
      if (patch.enabledAssistantIds !== undefined) push('enabled_assistant_ids', patch.enabledAssistantIds)
      if (patch.assistantRoutingNotes !== undefined) push('assistant_routing_notes', patch.assistantRoutingNotes)
      if (sets.length === 0) {
        const res = await query<Row>(`SELECT * FROM browser_profiles WHERE id = $1`, [id])
        return res.rows[0] ? toProfile(res.rows[0]) : null
      }
      sets.push('updated_at = now()')
      const res = await query<Row>(
        `UPDATE browser_profiles SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params,
      )
      return res.rows[0] ? toProfile(res.rows[0]) : null
    },

    async delete(id) {
      await query(`DELETE FROM browser_profiles WHERE id = $1`, [id])
    },
  }
}
