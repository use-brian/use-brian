import type { PoolClient } from 'pg'
import { getPool } from '../db/client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { sourceBinding, type ExternalApprovalSource, type ExternalApprovalInput, type AckStatus } from './contracts.js'
import { ExternalApprovalError, externalApprovals, type ExternalApprovalStore, type ExternalApprovalState } from './service.js'

/** Current membership AND assistant placement, never an assertion from the external payload. */
async function authorize(client: PoolClient, source: ExternalApprovalSource): Promise<void> {
  const member = await client.query(`SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, [source.workspaceId, source.approverUserId])
  const assistant = await client.query(`SELECT id FROM assistants WHERE workspace_id=$1 AND id=$2 FOR SHARE`, [source.workspaceId, source.assistantId])
  if (!member.rows.length || !assistant.rows.length || !(await client.query('SELECT public.assistant_placement_visible($1,$2) AS admitted', [source.approverUserId, source.assistantId])).rows[0]?.admitted) {
    throw new ExternalApprovalError(404, 'Approval source unavailable')
  }
}
const projection = `p.id AS "approvalId", e.external_request_id AS "externalRequestId", p.status,
  (e.superseded_at IS NOT NULL) AS superseded,
  e.expires_at AS "expiresAt", e.payload_hash AS "payloadHash", e.ack_status AS "ackStatus"`
function state(row: Record<string, unknown>): ExternalApprovalState {
  return { approvalId: row.approvalId as string, externalRequestId: row.externalRequestId as string,
    status: row.status as ExternalApprovalState['status'], expiresAt: new Date(row.expiresAt as string).toISOString(),
    payloadHash: row.payloadHash as string, ...(row.ackStatus ? { ackStatus: row.ackStatus as AckStatus } : {}) }
}
async function transaction<T>(source: ExternalApprovalSource, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect()
  try {
    await c.query('BEGIN')
    await authorize(c, source)
    const result = await fn(c)
    await authorize(c, source)
    await c.query('COMMIT')
    return result
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
async function locked(c: PoolClient, s: ExternalApprovalSource, id: string, byApproval = false): Promise<ExternalApprovalState | null> {
  const rows = await c.query(`SELECT ${projection} FROM external_approval_requests e JOIN pending_approvals p ON p.id=e.approval_id
    WHERE e.source_id=$1 AND e.source_binding=$2 AND ${byApproval ? 'p.id::text' : 'e.external_request_id'}=$3
      AND p.kind='external_action' AND p.workspace_id=$4 AND p.originating_assistant_id=$5 AND p.approver_user_id=$6
    FOR UPDATE OF p,e`, [s.id, sourceBinding(s), id, s.workspaceId, s.assistantId, s.approverUserId])
  if (!rows.rows[0]) return null
  let current = state(rows.rows[0])
  // Use the database clock after acquiring the row lock, including after lock waits.
  if (current.status === 'pending') {
    const expired = await c.query(`UPDATE pending_approvals SET status='expired',responded_at=clock_timestamp()
      WHERE id=$1 AND status='pending' AND expires_at<=clock_timestamp() RETURNING id`, [current.approvalId])
    if (expired.rows.length) current = { ...current, status: 'expired' }
  }
  if (rows.rows[0].superseded) current = { ...current, status: 'superseded' }
  // Expiry is an applicability projection, never a rewrite of a recorded human decision.
  // An already applied receipt remains historical evidence of application, not a new grant.
  if ((current.status === 'approved' || current.status === 'rejected') && !current.ackStatus) {
    const elapsed = await c.query('SELECT $1::timestamptz<=clock_timestamp() AS elapsed', [current.expiresAt])
    if (elapsed.rows[0]?.elapsed) current = { ...current, status: 'expired' }
  }
  return current
}
export function createExternalApprovalSqlStore(): ExternalApprovalStore {
  return {
    async sourceForApproval(id) {
      const result = await getPool().query('SELECT source_id,source_binding FROM external_approval_requests WHERE approval_id=$1', [id])
      return result.rows[0] ? { sourceId: result.rows[0].source_id, binding: result.rows[0].source_binding } : null
    },
    async create(s, input, hash) {
      const result = await transaction(s, async c => {
        // Serializes concurrent first inserts without creating orphan pending rows.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([s.id, input.externalRequestId])])
        const existing = await c.query('SELECT payload_hash,source_binding FROM external_approval_requests WHERE source_id=$1 AND external_request_id=$2', [s.id, input.externalRequestId])
        if (existing.rows[0]) {
          if (existing.rows[0].payload_hash !== hash || existing.rows[0].source_binding !== sourceBinding(s)) throw new ExternalApprovalError(409, 'Immutable request conflict')
          const current = await locked(c, s, input.externalRequestId)
          if (!current) throw new ExternalApprovalError(404, 'Approval unavailable')
          return { state: current, created: false }
        }
        const time = await c.query(`SELECT LEAST($1::timestamptz,clock_timestamp()+interval '5 minutes') AS expiry, $1::timestamptz>clock_timestamp() AS fresh`, [input.expiresAt])
        if (!time.rows[0].fresh) throw new ExternalApprovalError(400, 'Expiry must be in the future')
        const expiry = time.rows[0].expiry
        const pending = await c.query(`INSERT INTO pending_approvals(workspace_id,kind,approver_user_id,originating_assistant_id,
          tool_name,arguments,approval_payload,delivery_channel_type,delivery_channel_id,expires_at)
          VALUES($1,'external_action',$2,$3,NULL,'{}'::jsonb,$4,$5,$6,$7) RETURNING id`,
          [s.workspaceId,s.approverUserId,s.assistantId,JSON.stringify({ request: input.request, allowPersistentApproval: false }),s.channelType,s.channelId,expiry])
        const id = pending.rows[0].id
        await c.query(`INSERT INTO external_approval_requests(approval_id,source_id,source_binding,external_request_id,task_id,session_id,payload_hash,immutable_input,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id,s.id,sourceBinding(s),input.externalRequestId,input.taskId,input.sessionId,hash,JSON.stringify(input),expiry])
        return { state: { approvalId: id, externalRequestId: input.externalRequestId, status: 'pending' as const, expiresAt: new Date(expiry).toISOString(), payloadHash: hash }, created: true }
      })
      if (result.created) notifyWorkspaceChange(s.workspaceId, 'approval', 'create', result.state.approvalId)
      return result
    },
    read: (s,id) => transaction(s, c => locked(c,s,id)),
    ack: (s,id,status) => transaction(s, async c => {
      const current = await locked(c,s,id)
      if (!current) return null
      if (current.status === 'pending' || (status === 'applied' && current.status !== 'approved' && current.status !== 'rejected')) throw new ExternalApprovalError(409, 'No applicable human decision')
      if (current.ackStatus && current.ackStatus !== status) throw new ExternalApprovalError(409, 'Receipt conflict')
      await c.query('UPDATE external_approval_requests SET ack_status=$2,acknowledged_at=COALESCE(acknowledged_at,clock_timestamp()) WHERE approval_id=$1', [current.approvalId,status])
      return { ...current, ackStatus: status }
    }),
    cancel: async (s,id) => {
      const result = await transaction(s, async c => {
        const current = await locked(c,s,id)
        if (!current) return null
        // Cancellation invalidates even an approved but not-yet-consumed decision.
        if (!current.ackStatus && (current.status === 'pending' || current.status === 'approved')) {
          await c.query('UPDATE external_approval_requests SET superseded_at=COALESCE(superseded_at,clock_timestamp()) WHERE approval_id=$1', [current.approvalId])
          // Preserve an already recorded human approval and its timestamp as audit evidence.
          await c.query("UPDATE pending_approvals SET status='superseded',responded_at=clock_timestamp() WHERE id=$1 AND status='pending'", [current.approvalId])
          return { ...current, status: 'superseded' as const }
        }
        return current
      })
      if (result) notifyWorkspaceChange(s.workspaceId,'approval','update',result.approvalId)
      return result
    },
    decide: async (s,id,userId,decision) => {
      if (userId !== s.approverUserId) return null
      const result = await transaction(s, async c => {
        const current = await locked(c,s,id,true)
        if (!current || current.status !== 'pending') return current
        const changed = await c.query(`UPDATE pending_approvals SET status=$2,responded_by=$3,responded_at=clock_timestamp(),resolution_origin='human'
          WHERE id=$1 AND kind='external_action' AND status='pending' AND approver_user_id=$3
            AND expires_at>clock_timestamp() RETURNING id`, [id,decision,userId])
        // Expiry is enforced in the final write, not merely on the UI read.
        if (!changed.rows.length) return locked(c,s,id,true)
        return { ...current, status: decision }
      })
      if (result) notifyWorkspaceChange(s.workspaceId,'approval','update',id)
      return result
    },
  }
}
/** Used by the unified queue projection; sidecar metadata never leaves this boundary. */
export async function canReadExternalApproval(userId: string, id: string): Promise<boolean> {
  try {
    const service = externalApprovals()
    const binding = await service.store.sourceForApproval(id)
    const source = binding && service.sources.find(s => s.id === binding.sourceId && sourceBinding(s) === binding.binding && s.approverUserId === userId)
    if (!source) return false
    return !!await transaction(source, c => locked(c, source, id, true))
  } catch { return false }
}
