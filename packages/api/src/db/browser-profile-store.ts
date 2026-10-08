/**
 * DB-backed browser-profile store over `browser_profiles`.
 *
 * [COMP:sandbox/profiles]
 */
import type {
  BrowserProfile,
  BrowserProfileAuthority,
  BrowserProfileStore,
  CreateBrowserProfileParams,
  UpdateBrowserProfileParams,
} from '@use-brian/core'
import type { PoolClient } from 'pg'
import { canRead } from '@use-brian/core'
import { query, getPool } from './client.js'
import { loadDepartmentSnapshot } from '../context-scope/department-resolver.js'
import { read, write, updatePreservesFloor } from '../context-scope/reference-predicate.js'

type AuthoritySnapshot = NonNullable<Parameters<BrowserProfileStore['update']>[2]>

/** Lock human create/PATCH inputs through persistence, including revocation rows. */
async function admitMutation(client: PoolClient, id: string | null, expected: AuthoritySnapshot, patch: UpdateBrowserProfileParams, intent: 'write' | 'delete' = 'write') {
  const workspace = (await client.query<{ department_read_v2: boolean }>(
    'SELECT department_read_v2 FROM workspaces WHERE id=$1 FOR SHARE', [expected.workspaceId])).rows[0]
  if (!workspace) return { allowed: false, expiresAt: null }
  const member = await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',
    [expected.workspaceId, expected.ownerUserId])
  if (!member.rowCount) return { allowed: false, expiresAt: null }
  if (!expected.departmentId) {
    return { allowed: !(patch.departmentId || (intent !== 'delete' && workspace.department_read_v2 && (patch.scope ?? expected.scope) === 'workspace')), expiresAt: null }
  }
  const department = await client.query("SELECT id FROM workspace_groups WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [expected.workspaceId, expected.departmentId])
  if (!department.rowCount || (patch.departmentId !== undefined && patch.departmentId !== expected.departmentId)) {
    return { allowed: false, expiresAt: null }
  }
  await client.query('SELECT id FROM department_edges WHERE workspace_id=$1 AND user_id=$2 AND department_id=$3 ORDER BY id FOR SHARE',
    [expected.workspaceId, expected.ownerUserId, expected.departmentId])
  if (id) await client.query('SELECT id FROM browser_profiles WHERE id=$1 FOR UPDATE', [id])
  const { snapshot, principal } = await loadDepartmentSnapshot(
    async <R>(sql: string, values: unknown[]) => ({ rows: (await client.query(sql, values)).rows as R[] }),
    { workspaceId: expected.workspaceId, userId: expected.ownerUserId, assistantId: null })
  const now = new Date()
  const source = { id: 'browser-profile', workspaceId: expected.workspaceId, tier: expected.clearance,
    departmentIds: [expected.departmentId], userId: expected.ownerUserId }
  const requested = { tier: patch.clearance ?? expected.clearance, departmentIds: [expected.departmentId] }
  const admission = write(snapshot, { principal, assistant: null }, { requestedTier: requested.tier, sources: id ? [source] : [] },
    { workspaceId: expected.workspaceId, department: expected.departmentId, now })
  const deadlines = snapshot.edges.filter(edge => edge.departmentId === expected.departmentId && edge.expiresAt
    && edge.expiresAt.getTime() > now.getTime()).map(edge => edge.expiresAt!.getTime())
  return { allowed: principal.kind === 'user' && admission.allowed && updatePreservesFloor(source, requested),
    expiresAt: deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null }
}

type Row = {
  id: string
  workspace_id: string
  owner_user_id: string
  name: string
  department_id: string | null
  scope: 'owner' | 'workspace'
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
    scope: row.scope,
    departmentId: row.department_id ?? null,
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

/** Persistent child operations share the admitted owner's profile transaction. */
export async function withBrowserProfileOwnerMutation<T>(profileId: string, expected: BrowserProfileAuthority,
  operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const denied = () => Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
  if (profileId !== expected.id) throw denied()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const admission = await admitMutation(client, profileId, expected, {})
    if (!admission.allowed) throw denied()
    const current = await client.query(`SELECT id FROM browser_profiles WHERE id=$1 AND workspace_id=$2
      AND owner_user_id=$3 AND department_id IS NOT DISTINCT FROM $4::uuid AND scope=$5 AND clearance=$6 FOR UPDATE`,
    [profileId, expected.workspaceId, expected.ownerUserId, expected.departmentId ?? null, expected.scope, expected.clearance])
    if (!current.rowCount) throw denied()
    const result = await operation(client)
    if (admission.expiresAt) {
      const fresh = await client.query('SELECT clock_timestamp() < $1::timestamptz AS fresh', [admission.expiresAt])
      if (!fresh.rows[0]?.fresh) throw denied()
    }
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
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

    async create(params: CreateBrowserProfileParams, actor) {
      const denied = () => Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
      if (actor && actor.userId !== params.ownerUserId) throw denied()
      const client = actor ? await getPool().connect() : null
      try {
        if (client) await client.query('BEGIN')
        const admission = client ? await admitMutation(client, null, {
          workspaceId: params.workspaceId, ownerUserId: params.ownerUserId, departmentId: params.departmentId ?? null,
          scope: params.scope ?? 'owner', clearance: params.clearance ?? 'confidential',
        }, { scope: params.scope ?? 'owner' }) : null
        if (admission && !admission.allowed) throw denied()
        const execute = client ? client.query.bind(client) : query
        const res = await execute<Row>(
          `INSERT INTO browser_profiles
             (workspace_id, owner_user_id, name, scope, clearance, enabled_assistant_ids, department_id,
              assistant_routing_notes, default_backend, local_control_mode, proxy_url)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
            WHERE $12::timestamptz IS NULL OR clock_timestamp() < $12::timestamptz
           RETURNING *`,
          [
            params.workspaceId,
            params.ownerUserId,
            params.name,
            params.scope ?? 'owner',
            params.clearance ?? 'confidential',
            params.enabledAssistantIds ?? [],
            params.departmentId ?? null,
            params.assistantRoutingNotes ?? {},
            params.defaultBackend ?? 'cloud',
            params.localControlMode ?? 'task_tabs',
            params.proxyUrl ?? null,
            admission?.expiresAt ?? null,
          ],
        )
        if (!res.rows[0]) throw denied()
        if (client) await client.query('COMMIT')
        return toProfile(res.rows[0])
      } catch (error) {
        if (client) await client.query('ROLLBACK')
        throw error
      } finally {
        client?.release()
      }
    },

    async update(id, patch: UpdateBrowserProfileParams, expected) {
      const client = expected ? await getPool().connect() : null
      try {
        if (client) await client.query('BEGIN')
        const admission = client && expected ? await admitMutation(client, id, expected, patch) : null
        if (admission && !admission.allowed) {
          await client!.query('ROLLBACK')
          return null
        }
        const execute = client ? client.query.bind(client) : query
        const sets: string[] = []
        const params: unknown[] = [id]
        const guards = ['id = $1']
        if (expected) {
          for (const [column, value] of [
            ['workspace_id', expected.workspaceId], ['owner_user_id', expected.ownerUserId],
            ['department_id', expected.departmentId ?? null], ['scope', expected.scope], ['clearance', expected.clearance],
          ]) {
            params.push(value)
            guards.push(`${column} IS NOT DISTINCT FROM $${params.length}`)
          }
        }
        if (admission?.expiresAt) {
          params.push(admission.expiresAt)
          guards.push(`clock_timestamp() < $${params.length}::timestamptz`)
        }
        const push = (sql: string, value: unknown) => {
          params.push(value)
          sets.push(`${sql} = $${params.length}`)
        }
        if (patch.name !== undefined) push('name', patch.name)
        if (patch.departmentId !== undefined) push('department_id', patch.departmentId)
        if (patch.scope !== undefined) push('scope', patch.scope)
        if (patch.clearance !== undefined) push('clearance', patch.clearance)
        if (patch.defaultBackend !== undefined) push('default_backend', patch.defaultBackend)
        if (patch.localControlMode !== undefined) push('local_control_mode', patch.localControlMode)
        if (patch.proxyUrl !== undefined) push('proxy_url', patch.proxyUrl)
        if (patch.enabledAssistantIds !== undefined) push('enabled_assistant_ids', patch.enabledAssistantIds)
        if (patch.assistantRoutingNotes !== undefined) push('assistant_routing_notes', patch.assistantRoutingNotes)
        if (sets.length === 0) {
          const res = await execute<Row>(`SELECT * FROM browser_profiles WHERE ${guards.join(' AND ')}`, params)
          if (client) await client.query('COMMIT')
          return res.rows[0] ? toProfile(res.rows[0]) : null
        }
        sets.push('updated_at = now()')
        const res = await execute<Row>(
          `UPDATE browser_profiles SET ${sets.join(', ')} WHERE ${guards.join(' AND ')} RETURNING *`,
          params,
        )
        if (client) await client.query('COMMIT')
        return res.rows[0] ? toProfile(res.rows[0]) : null
      } catch (error) {
        if (client) await client.query('ROLLBACK')
        throw error
      } finally {
        client?.release()
      }
    },

    async classifyDepartment(id, input) {
      const denied = (code = 'profile_authority_denied') => Object.assign(new Error('Profile classification unavailable'), { code })
      const expected = input.expected
      if (id !== expected.id || input.userId !== expected.ownerUserId) throw denied()
      const pin = input.agentRead
      if (pin && (!pin.assistantId || pin.workspaceId !== expected.workspaceId || pin.userId !== input.userId)) throw denied()
      if (!input.reason.trim() || input.reason.trim().length > 1000) throw denied('reason_required')
      if (!input.confirmed) throw denied('confirmation_required')
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const workspace = (await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1 FOR SHARE',[expected.workspaceId])).rows[0]
        const member = (await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[expected.workspaceId,input.userId])).rows[0]
        if (!workspace || !member) throw denied()
        const oldDepartment = expected.departmentId ?? null
        if (oldDepartment === input.departmentId) throw denied('unchanged')
        const widening = oldDepartment !== null
        if (widening && !['owner','admin'].includes(member.role)) throw denied('admin_confirmation_required')
        if (!input.departmentId && expected.scope === 'workspace' && workspace.department_read_v2) throw denied('department_required')
        const departments = [...new Set([oldDepartment,input.departmentId].filter((id): id is string => Boolean(id)))].sort()
        let placementDepartment: string | null = null
        if (pin) {
          const assistant = (await client.query<{placement_department_id:string|null}>(
            'SELECT placement_department_id FROM assistants WHERE id=$1 AND workspace_id=$2 FOR SHARE',
            [pin.assistantId,expected.workspaceId])).rows[0]
          if (!assistant) throw denied()
          placementDepartment = assistant.placement_department_id
          if (pin.contextDepartment !== null && ((oldDepartment !== null && oldDepartment !== pin.contextDepartment) || input.departmentId !== pin.contextDepartment)) throw denied()
          for (const department of departments) {
            const ceiling = pin.departments[department]
            if (!ceiling || !canRead(ceiling,expected.clearance) || (pin.binding !== null && !pin.binding.includes(department))) throw denied()
          }
          if ((!oldDepartment || !input.departmentId) && !canRead(pin.base,expected.clearance)) throw denied()
          if (pin.cap && !canRead(pin.cap,expected.clearance)) throw denied()
        }
        const active = await client.query("SELECT id FROM workspace_groups WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind='team' AND status='active' ORDER BY id FOR SHARE",[expected.workspaceId,departments])
        if (active.rowCount !== departments.length) throw denied()
        if (placementDepartment) await client.query('SELECT id FROM workspace_groups WHERE workspace_id=$1 AND id=$2 FOR SHARE',[expected.workspaceId,placementDepartment])
        const authorityDepartments = [...new Set([...departments,...(placementDepartment?[placementDepartment]:[])])].sort()
        const edges = await client.query<{expires_at: Date | null}>('SELECT expires_at FROM department_edges WHERE workspace_id=$1 AND (user_id=$2 OR assistant_id=$4) AND department_id=ANY($3::uuid[]) ORDER BY id FOR SHARE',[expected.workspaceId,input.userId,authorityDepartments,pin?.assistantId??null])
        const current = (await client.query<Row>(`SELECT * FROM browser_profiles WHERE id=$1 AND workspace_id=$2
          AND owner_user_id=$3 AND department_id IS NOT DISTINCT FROM $4::uuid AND scope=$5 AND clearance=$6 FOR UPDATE`,
          [id,expected.workspaceId,input.userId,oldDepartment,expected.scope,expected.clearance])).rows[0]
        if (!current) throw denied('profile_changed')
        if (pin && !current.enabled_assistant_ids?.includes(pin.assistantId!)) throw denied()
        const {snapshot,principal} = await loadDepartmentSnapshot(async <R>(sql: string, values: unknown[]) => ({rows:(await client.query(sql,values)).rows as R[]}),
          {workspaceId:expected.workspaceId,userId:input.userId,assistantId:pin?.assistantId??null})
        const reader = {principal,assistant:pin?.assistantId?{kind:'assistant' as const,id:pin.assistantId}:null}
        const now = new Date()
        // Confirmed widening explicitly releases the old floor after checking its authority.
        // The destination still requires canonical WRITE at the unchanged clearance.
        for (const department of departments) {
          if (pin && !read(snapshot,reader,{id,workspaceId:expected.workspaceId,tier:expected.clearance,departmentIds:[department],userId:input.userId},
            {workspaceId:expected.workspaceId,department,now})) throw denied()
          if (!write(snapshot,reader,{requestedTier:expected.clearance,sources:[]},
            {workspaceId:expected.workspaceId,department,now}).allowed) throw denied()
        }
        if (pin && !oldDepartment && !read(snapshot,reader,{id,workspaceId:expected.workspaceId,tier:expected.clearance,departmentIds:[],userId:input.userId},
          {workspaceId:expected.workspaceId,department:null,now})) throw denied()
        if ((!input.departmentId || (pin && !oldDepartment)) && !write(snapshot,reader,{requestedTier:expected.clearance,sources:[],explicitGeneral:true},
          {workspaceId:expected.workspaceId,department:null,now}).allowed) throw denied()
        const changed = await client.query<Row>('UPDATE browser_profiles SET department_id=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',[id,input.departmentId])
        await client.query("UPDATE browser_skill_grants SET status='revoked' WHERE profile_id=$1 AND status='active'",[id])
        await client.query(`INSERT INTO context_scope_reclassification_events
          (workspace_id,primitive,row_id,previous_compartments,next_compartments,previous_project_ids,next_project_ids,actor_user_id,reason,widening)
          VALUES($1,'browser_profile',$2,$3::text[],$4::text[],'{}','{}',$5,$6,$7)`,
          [expected.workspaceId,id,oldDepartment?[`team:${oldDepartment}`]:[],input.departmentId?[`team:${input.departmentId}`]:[],input.userId,input.reason.trim(),widening])
        const deadlines = edges.rows.flatMap(row=>row.expires_at?[row.expires_at.getTime()]:[]).filter(time=>time>now.getTime())
        if (deadlines.length && !(await client.query('SELECT clock_timestamp()<$1::timestamptz AS fresh',[new Date(Math.min(...deadlines))])).rows[0]?.fresh) throw denied()
        await client.query('COMMIT')
        return toProfile(changed.rows[0])
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    },

    async delete(id, expected) {
      if (!expected) return (await query('DELETE FROM browser_profiles WHERE id=$1', [id])).rowCount === 1
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const admission = await admitMutation(client, id, expected, {}, 'delete')
        if (!admission.allowed) {
          await client.query('ROLLBACK')
          return false
        }
        const result = await client.query(`DELETE FROM browser_profiles WHERE id=$1
          AND workspace_id=$2 AND owner_user_id=$3 AND department_id IS NOT DISTINCT FROM $4::uuid
          AND scope=$5 AND clearance=$6 AND ($7::timestamptz IS NULL OR clock_timestamp()<$7::timestamptz)`,
        [id, expected.workspaceId, expected.ownerUserId, expected.departmentId ?? null,
          expected.scope, expected.clearance, admission.expiresAt])
        await client.query('COMMIT')
        return result.rowCount === 1
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}
