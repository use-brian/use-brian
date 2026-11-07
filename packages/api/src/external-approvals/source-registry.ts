import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { getPool } from '../db/client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import type { RecentApprovalResolver } from '../workflow/recent-approval-channel.js'
import { PROACTIVE_DELIVERY_TRANSPORTS } from '../session-kind.js'
import { sourceBinding, type ExternalApprovalSource } from './contracts.js'
import { ExternalApprovalError } from './service.js'

export type PublicExternalApprovalSource = Omit<ExternalApprovalSource, 'tokenSha256'> & {
  name: string; prefix: string; createdAt: string; revokedAt: string | null
}
export const createExternalApprovalSourceSchema = z.object({
  name: z.string().trim().min(1).max(120).refine(s => !/[\u0000-\u001f\u007f]/.test(s)),
  assistantId: z.string().uuid(), approverUserId: z.string().uuid(),
  notification: z.enum(['web', 'verified_channel']).default('web'),
}).strict()
export type CreateExternalApprovalSource = z.infer<typeof createExternalApprovalSourceSchema>
export type ExternalApprovalSourceActor = { userId: string; sessionId: string }
export interface ExternalApprovalSourceManagementStore {
  list(workspaceId: string): Promise<PublicExternalApprovalSource[]>
  create(actor: ExternalApprovalSourceActor, workspaceId: string, input: CreateExternalApprovalSource): Promise<{ source: PublicExternalApprovalSource; token: string }>
  rotate(actor: ExternalApprovalSourceActor, workspaceId: string, sourceId: string): Promise<{ source: PublicExternalApprovalSource; token: string }>
  revoke(actor: ExternalApprovalSourceActor, workspaceId: string, sourceId: string): Promise<void>
}
const publicColumns = `id,name,workspace_id AS "workspaceId",assistant_id AS "assistantId",approver_user_id AS "approverUserId",
  channel_type AS "channelType",channel_id AS "channelId",channel_integration_id AS "channelIntegrationId",prefix,
  created_at AS "createdAt",revoked_at AS "revokedAt"`
const privateColumns = `id,token_sha256 AS "tokenSha256",workspace_id AS "workspaceId",assistant_id AS "assistantId",
  approver_user_id AS "approverUserId",channel_type AS "channelType",channel_id AS "channelId",channel_integration_id AS "channelIntegrationId"`
function sourceRow(row: ExternalApprovalSource): ExternalApprovalSource {
  const { channelIntegrationId, ...rest } = row
  return { ...rest, ...(channelIntegrationId ? { channelIntegrationId } : {}) }
}
function publicRow(row: PublicExternalApprovalSource): PublicExternalApprovalSource {
  return { id:row.id,workspaceId:row.workspaceId,assistantId:row.assistantId,approverUserId:row.approverUserId,
    channelType:row.channelType,channelId:row.channelId,...(row.channelIntegrationId ? {channelIntegrationId:row.channelIntegrationId} : {}),name: row.name, prefix: row.prefix,
    createdAt: new Date(row.createdAt).toISOString(), revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null } as PublicExternalApprovalSource
}
const unavailable = () => new ExternalApprovalError(404, 'Approval source unavailable')
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
function credential() {
  const token = `eas_${randomBytes(32).toString('base64url')}`
  return { token, hash: digest(token), prefix: token.slice(0, 12) }
}
/** Locks against rotation/revocation until the caller's approval transaction commits. */
export async function lockExternalApprovalSource(client: PoolClient, source: ExternalApprovalSource): Promise<void> {
  const row = (await client.query<ExternalApprovalSource>(`SELECT ${privateColumns} FROM workspace_external_approval_sources
    WHERE id::text=$1 AND revoked_at IS NULL FOR SHARE`, [source.id])).rows[0]
  if (!row || row.tokenSha256 !== source.tokenSha256 || sourceBinding(sourceRow(row)) !== sourceBinding(source)) throw unavailable()
}

export function createExternalApprovalSourceRegistry(options: {
  pool?: Pick<Pool, 'query' | 'connect'>; resolveRecentChannel?: RecentApprovalResolver; notify?: (workspaceId: string) => void
} = {}) {
  const pool = () => options.pool ?? getPool()
  const notify = options.notify ?? (workspaceId => { notifyWorkspaceChange(workspaceId, 'workspace_config', 'update') })
  async function transaction<T>(actor: ExternalApprovalSourceActor, workspaceId: string, work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool().connect()
    try {
      await c.query('BEGIN')
      // Lock the session and user version, matching authenticated-session admission.
      const session = await c.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND s.auth_version=u.auth_version FOR SHARE OF s,u`, [actor.sessionId, actor.userId])
      if (!session.rows.length) throw new ExternalApprovalError(403, 'Authenticated human session required')
      const role = await c.query(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, [workspaceId, actor.userId])
      if (!['owner','admin'].includes(role.rows[0]?.role)) throw new ExternalApprovalError(403, 'Workspace administrator required')
      const result = await work(c)
      // The ledger rows remain locked, but wall-clock expiry can still elapse.
      const fresh = await c.query('SELECT id FROM auth_sessions WHERE id=$1 AND expires_at>clock_timestamp()', [actor.sessionId])
      if (!fresh.rows.length) throw new ExternalApprovalError(403, 'Authenticated human session required')
      await c.query('COMMIT')
      try { notify(workspaceId) } catch { /* Committed configuration must not lose its one-time response. */ }
      return result
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error } finally { c.release() }
  }
  async function validateBinding(c: PoolClient, actor: ExternalApprovalSourceActor, workspaceId: string, input: CreateExternalApprovalSource) {
    const member = await c.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId,input.approverUserId])
    const assistant = await c.query(`SELECT id FROM assistants WHERE workspace_id=$1 AND id=$2
      AND public.assistant_placement_visible($3,id) AND public.assistant_placement_visible($4,id) FOR SHARE`,
    [workspaceId,input.assistantId,actor.userId,input.approverUserId])
    if (!member.rows.length || !assistant.rows.length) throw unavailable()
  }
  return {
    async get(id: string): Promise<ExternalApprovalSource | null> {
      const row = (await pool().query<ExternalApprovalSource>(`SELECT ${privateColumns} FROM workspace_external_approval_sources WHERE id::text=$1 AND revoked_at IS NULL`, [id])).rows[0]
      return row ? sourceRow(row) : null
    },
    async authenticate(header?: string): Promise<ExternalApprovalSource | null> {
      if (!header || !/^Bearer [!-~]{16,4096}$/.test(header)) return null
      const row = (await pool().query<ExternalApprovalSource>(`SELECT ${privateColumns} FROM workspace_external_approval_sources WHERE token_sha256=$1 AND revoked_at IS NULL`, [digest(header.slice(7))])).rows[0]
      return row ? sourceRow(row) : null
    },
    async list(workspaceId: string): Promise<PublicExternalApprovalSource[]> {
      return (await pool().query<PublicExternalApprovalSource>(`SELECT ${publicColumns} FROM workspace_external_approval_sources WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId])).rows.map(publicRow)
    },
    async create(actor: ExternalApprovalSourceActor, workspaceId: string, raw: CreateExternalApprovalSource) {
      const input = createExternalApprovalSourceSchema.parse(raw)
      return transaction(actor, workspaceId, async c => {
        await validateBinding(c,actor,workspaceId,input)
        let target: Pick<ExternalApprovalSource,'channelType'|'channelId'|'channelIntegrationId'> = { channelType:'web',channelId:'queue' }
        if (input.notification === 'verified_channel') {
          const resolveChannel = options.resolveRecentChannel ?? (await import('../workflow/recent-approval-channel.js'))
            .createRecentApprovalChannelResolver((text, values) => c.query(text, values))
          const resolved = await resolveChannel({workspaceId,assistantId:input.assistantId,approverUserId:input.approverUserId})
          if (!resolved || !resolved.channelId) {
            throw new ExternalApprovalError(409, 'Verified notification destination unavailable')
          }
          // Personal web chat is a first-class verified destination: no channel
          // integration exists, and channelId is the durable session id.
          if (resolved.channelType === 'web') {
            target = { channelType: 'web', channelId: resolved.channelId }
          } else if (!resolved.channelIntegrationId || !z.string().uuid().safeParse(resolved.channelIntegrationId).success
            || !(PROACTIVE_DELIVERY_TRANSPORTS as readonly string[]).includes(resolved.channelType)) {
            throw new ExternalApprovalError(409, 'Verified notification destination unavailable')
          } else {
            target = resolved
          }
        }
        const key = credential()
        const row = (await c.query<PublicExternalApprovalSource>(`INSERT INTO workspace_external_approval_sources
          (id,workspace_id,name,assistant_id,approver_user_id,channel_type,channel_id,channel_integration_id,token_sha256,prefix,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${publicColumns}`,
        [randomUUID(),workspaceId,input.name,input.assistantId,input.approverUserId,target.channelType,target.channelId,target.channelIntegrationId ?? null,key.hash,key.prefix,actor.userId])).rows[0]
        return {source:publicRow(row),token:key.token}
      })
    },
    async rotate(actor: ExternalApprovalSourceActor, workspaceId: string, sourceId: string) {
      return transaction(actor,workspaceId,async c => {
        const current = (await c.query<PublicExternalApprovalSource>(`SELECT ${publicColumns} FROM workspace_external_approval_sources
          WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL FOR UPDATE`, [workspaceId,sourceId])).rows[0]
        if (!current) throw unavailable()
        await validateBinding(c,actor,workspaceId,{name:current.name,assistantId:current.assistantId,approverUserId:current.approverUserId,notification:'web'})
        const key = credential()
        const row = (await c.query<PublicExternalApprovalSource>(`UPDATE workspace_external_approval_sources SET token_sha256=$4,prefix=$5,rotated_by=$3,rotated_at=clock_timestamp()
          WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING ${publicColumns}`, [workspaceId,sourceId,actor.userId,key.hash,key.prefix])).rows[0]
        if (!row) throw unavailable()
        return {source:publicRow(row),token:key.token}
      })
    },
    async revoke(actor: ExternalApprovalSourceActor, workspaceId: string, sourceId: string) {
      await transaction(actor,workspaceId,async c => {
        const row = (await c.query(`UPDATE workspace_external_approval_sources SET revoked_by=$3,revoked_at=clock_timestamp()
          WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`, [workspaceId,sourceId,actor.userId])).rows[0]
        if (!row) throw unavailable()
      })
    },
  }
}
