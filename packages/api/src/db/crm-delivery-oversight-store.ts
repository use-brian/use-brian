/** Current-source/RLS read projection. Spec: client-delivery-oversight.md.
 * [COMP:api/crm-delivery-oversight]
 */
import type { PoolClient, QueryResultRow } from 'pg'
import { assessDelivery, type AccessContext, type DeliveryCommitment, type DeliveryDetail,
  type DeliveryObservation, type DeliveryLinkedWork, type DeliveryReadPort, type DeliverySource, type DeliverySourceRef, type DeliveryViewer } from '@use-brian/core'
import { getAppPool, applyRLSGucs } from './client.js'
import { commercialVisibility } from './crm-commercial-context-store.js'
import { queryCrmPage } from '../crm-operations/pagination.js'

type Run = <T extends QueryResultRow>(userId: string, sql: string, values: unknown[]) => Promise<{ rows: T[] }>
export const DELIVERY_COMMITMENT_COLUMNS = `c.id,c.workspace_id AS "workspaceId",c.candidate_key AS "candidateKey",
 c.source_selector AS source,c.outcome,to_char(c.due_date,'YYYY-MM-DD') AS "dueDate",c.company_id AS "companyId",c.deal_id AS "dealId",
 c.task_ids AS "taskIds",c.goal_ids AS "goalIds",c.agreeing_user_id AS "agreeingUserId",c.recognition_state AS "recognitionState",
 c.recognition_reason AS "recognitionReason",c.version,c.origin_chat_id AS "originChatId",c.created_at AS "createdAt",c.updated_at AS "updatedAt",(SELECT name FROM users WHERE id=c.agreeing_user_id) AS "agreeingName"`
const OBSERVATION_COLUMNS = `o.id,o.commitment_id AS "commitmentId",o.source_selector AS source,o.kind,o.claim,o.statement,
 o.work_id AS "workId",o.reporter_user_id AS "reporterUserId",o.occurred_at AS "occurredAt",o.read_at AS "readAt",(SELECT name FROM users WHERE id=o.reporter_user_id) AS "reporterName"`
const instant = (v: unknown) => new Date(v as string).toISOString()
export function deliveryCommitmentRow(row: Record<string, unknown>): DeliveryCommitment {
  return { ...row, createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt) } as DeliveryCommitment
}
function observationRow(row: Record<string, unknown>): DeliveryObservation {
  return { ...row, occurredAt: instant(row.occurredAt), readAt: instant(row.readAt) } as DeliveryObservation
}

/** Current membership/agent and optional persisted destination chat. Server-only actor. */
export function deliveryVisibility(viewer: DeliveryViewer, workspaceId: string, alias: 'c' | 'o', start: number, operation: 'read' | 'mutation' = 'read') {
  const ap = commercialVisibility(viewer.userId, workspaceId, alias, start, operation, viewer.access)
  const chat = `$${ap.nextIdx}`
  return { sql: `${ap.sql} AND crm_delivery_source_visible(${alias}.workspace_id,${alias}.source_kind,${alias}.source_id,${alias}.source_revision,${chat}::uuid)
    AND crm_delivery_envelope_visible(${alias}.workspace_id,${alias}.user_id,${alias}.assistant_id,${alias}.sensitivity,${alias}.compartments,${alias}.project_ids,${chat}::uuid)`,
    params: [...ap.params, viewer.chatId ?? null], nextIdx: ap.nextIdx + 1 }
}

export async function readDeliverySource(client: PoolClient, viewer: DeliveryViewer, workspaceId: string, ref: DeliverySourceRef): Promise<DeliverySource | null> {
  const row = (await client.query<{ source: Record<string, unknown> | null }>(`SELECT crm_delivery_source_snapshot($1,$2,$3) AS source
    WHERE crm_delivery_source_visible($1,$2,$3,$4,$5)`, [workspaceId, ref.kind, ref.id, ref.revision, viewer.chatId ?? null])).rows[0]?.source
  if (!row) return null
  // Explicit access predicate is also applied for caller-supplied native contexts,
  // including shared audience. GUCs independently intersect current agent grants.
  const ap = commercialVisibility(viewer.userId, workspaceId, 's', 2, 'read', viewer.access)
  const admitted = await client.query(`SELECT 1 FROM jsonb_to_record($1::jsonb) AS s(workspace_id uuid,user_id uuid,assistant_id uuid,
    sensitivity text,compartments text[],project_ids uuid[]) WHERE ${ap.sql}`,
  [JSON.stringify({ workspace_id: workspaceId, user_id: row.userId, assistant_id: row.assistantId,
    sensitivity: row.sensitivity, compartments: row.compartments, project_ids: row.projectIds }), ...ap.params])
  if (!admitted.rowCount) return null
  return { ...row, ...ref, occurredAt: instant(row.occurredAt), readAt: new Date().toISOString() } as DeliverySource
}

/** Linked native identity/work is admitted independently; ids are not grants. */
export async function deliveryLinkVisible(client: Pick<PoolClient, 'query'>, viewer: DeliveryViewer, workspaceId: string, kind: 'entity' | 'task' | 'goal', id: string): Promise<boolean> {
  if (kind === 'goal') {
    const { getGoalById } = await import('./goals.js')
    const goal = await getGoalById(viewer.userId, id, client as PoolClient)
    if (!goal || goal.workspaceId !== workspaceId || goal.host?.type !== 'task' || !goal.host.id) return false
    return deliveryLinkVisible(client, viewer, workspaceId, 'task', goal.host.id)
  }
  const table = kind === 'entity' ? 'entities' : 'tasks'
  const ap = commercialVisibility(viewer.userId, workspaceId, 'l', 3, 'read', viewer.access)
  const extra = 'AND l.valid_to IS NULL AND l.retracted_at IS NULL AND NOT l.scope_held'
  const result = await client.query(`SELECT 1 FROM ${table} l WHERE l.workspace_id=$1 AND l.id=$2 ${extra} AND ${ap.sql}
    AND crm_delivery_envelope_visible(l.workspace_id,l.user_id,l.assistant_id,l.sensitivity,l.compartments,l.project_ids,$${ap.nextIdx}::uuid)`,
  [workspaceId, id, ...ap.params, viewer.chatId ?? null])
  return Boolean(result.rowCount)
}

export function createCrmDeliveryReadStore(run?: Run): DeliveryReadPort {
  if (!run) {
    const read = async <T>(viewer: DeliveryViewer, fn: (port: DeliveryReadPort) => Promise<T>): Promise<T> => {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, viewer.userId)
        const result = await fn(createCrmDeliveryReadStore((_userId, sql, values) => client.query(sql, values)))
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    return { list: (v,w,q) => read(v,port=>port.list(v,w,q)), get: (v,w,id) => read(v,port=>port.get(v,w,id)),
      locateChatSource:(v,w,s,q,t)=>read(v,port=>port.locateChatSource!(v,w,s,q,t)) }
  }
  const executeRead: Run = run
  async function safeLinks(viewer: DeliveryViewer, workspaceId: string, row: Record<string, unknown>) {
    const client = { query: <T extends QueryResultRow>(sql: string, values: unknown[]) => executeRead<T>(viewer.userId, sql, values) } as PoolClient
    for (const name of ['companyId', 'dealId'] as const) {
      if (row[name] && !await deliveryLinkVisible(client, viewer, workspaceId, 'entity', row[name] as string)) row[name] = null
    }
    for (const name of ['taskIds', 'goalIds'] as const) {
      const admitted: string[] = []
      for (const id of row[name] as string[]) if (await deliveryLinkVisible(client, viewer, workspaceId, name === 'taskIds' ? 'task' : 'goal', id)) admitted.push(id)
      row[name] = admitted
    }
    return deliveryCommitmentRow(row)
  }
  return {
    async locateChatSource(viewer,workspaceId,sessionId,quote,expectedText) {
      const ap=commercialVisibility(viewer.userId,workspaceId,'m',4,'read',viewer.access)
      const rows=(await executeRead(viewer.userId,`SELECT m.id,m.scope_version::text AS revision,m.content FROM session_messages m
        WHERE m.workspace_id=$1 AND m.session_id=$2 AND m.sender_user_id=$3 AND m.role='user' AND NOT m.scope_held AND ${ap.sql}
        ORDER BY m.sequence_num DESC LIMIT 20`,[workspaceId,sessionId,viewer.userId,...ap.params])).rows
      for(const row of rows) {
        const body=typeof row.content==='string'?row.content:Array.isArray(row.content)?row.content.filter(v=>v.type==='text').map(v=>v.text).join('\n'):''
        if(body!==expectedText)continue
        const start=body.indexOf(quote)
        if(start>=0)return {kind:'session_message',id:row.id as string,revision:row.revision as string,quote,start,end:start+quote.length}
      }
      return null
    },
    async list(viewer, workspaceId, input) {
      const scope = deliveryVisibility({ ...viewer, chatId: input.chatId ?? viewer.chatId }, workspaceId, 'c', 2)
      const params: unknown[] = [workspaceId, ...scope.params]
      let work = ''
      if (input.scope !== 'personal') {
        params.push(input.scope === 'project' ? input.scopeId : `team:${input.scopeId}`)
        work = input.scope === 'project' ? `AND $${params.length}::uuid=ANY(c.project_ids)` : `AND $${params.length}=ANY(c.compartments)`
      } else {
        params.push(viewer.userId)
        work = `AND (c.user_id=$${params.length} OR c.agreeing_user_id=$${params.length})`
      }
      const page = await queryCrmPage((sql, values) => executeRead(viewer.userId, sql, values), {
        workspaceId, resource: 'delivery-commitments', key: 'commitments', query: {limit:input.limit,cursor:input.cursor,createdAfter:input.createdAfter,createdBefore:input.createdBefore},
        sql: `SELECT ${DELIVERY_COMMITMENT_COLUMNS} FROM crm_delivery_commitments c WHERE c.workspace_id=$1 AND c.recognition_state<>'superseded' AND ${scope.sql} ${work}`, params,
      })
      return { commitments: await Promise.all(page.commitments.map(row => safeLinks(viewer, workspaceId, row))), nextCursor: page.nextCursor }
    },
    async get(viewer, workspaceId, id) {
      const scope = deliveryVisibility(viewer, workspaceId, 'c', 3)
      const raw = (await executeRead(viewer.userId, `SELECT ${DELIVERY_COMMITMENT_COLUMNS},crm_delivery_source_navigation(c.workspace_id,c.source_kind,c.source_id,c.source_revision,$${scope.nextIdx-1}::uuid) AS "sourceNavigation" FROM crm_delivery_commitments c WHERE c.workspace_id=$1 AND c.id=$2 AND ${scope.sql}`, [workspaceId, id, ...scope.params])).rows[0]
      if (!raw) return null
      const commitment = await safeLinks(viewer, workspaceId, raw)
      const obsScope = deliveryVisibility(viewer, workspaceId, 'o', 3)
      const page = await queryCrmPage((sql, values) => executeRead(viewer.userId, sql, values), { workspaceId, resource: `delivery-evidence:${id}`, key: 'observations', query: { limit: 20 },
        sql: `SELECT ${OBSERVATION_COLUMNS},crm_delivery_source_navigation(o.workspace_id,o.source_kind,o.source_id,o.source_revision,$${obsScope.nextIdx-1}::uuid) AS "sourceNavigation",o.created_at AS "createdAt" FROM crm_delivery_observations o WHERE o.workspace_id=$1 AND o.commitment_id=$2 AND o.withdrawn_at IS NULL AND ${obsScope.sql}`, params: [workspaceId, id, ...obsScope.params] })
      const finalEvidence = await executeRead(viewer.userId, `SELECT o.id FROM crm_delivery_observations o WHERE o.workspace_id=$1 AND o.commitment_id=$2
        AND o.withdrawn_at IS NULL AND o.id=ANY($${obsScope.nextIdx}::uuid[]) AND ${obsScope.sql}`, [workspaceId,id,...obsScope.params,page.observations.map(v=>v.id)])
      const visibleIds = new Set(finalEvidence.rows.map(v=>v.id))
      const observations = page.observations.filter(v=>visibleIds.has(v.id)).map(observationRow)
      for (const o of observations) if (o.workId && !commitment.taskIds.includes(o.workId) && !commitment.goalIds.includes(o.workId)) o.workId = null
      const linkedWork:DeliveryLinkedWork[]=[]
      const linkedIds=[...commitment.taskIds.map(id=>({id,kind:'task' as const})),...commitment.goalIds.map(id=>({id,kind:'goal' as const}))].slice(0,20)
      for(const link of linkedIds) {
        let taskId=link.id,goalTitle:string|null=null,goalStatus:string|null=null
        if(link.kind==='goal') {
          const g=(await executeRead(viewer.userId,`SELECT outcome,status,host_id FROM goals WHERE workspace_id=$1 AND id=$2 AND host_type='task' AND goal_crm_scope_visible(id)`,[workspaceId,link.id])).rows[0]
          if(!g)continue
          taskId=g.host_id as string;goalTitle=g.outcome as string;goalStatus=g.status as string
        }
        const ap=commercialVisibility(viewer.userId,workspaceId,'t',3,'read',viewer.access)
        const work=(await executeRead(viewer.userId,`SELECT t.title,t.status,coalesce(a.name,u.name) AS executor,
          fu.name AS followup FROM tasks t LEFT JOIN assistants a ON a.id=t.executor_assistant_id
          LEFT JOIN workspace_members wm ON wm.id=t.assignee_id AND wm.workspace_id=t.workspace_id LEFT JOIN users u ON u.id=wm.user_id
          LEFT JOIN workspace_members fm ON fm.id=t.follow_up_member_id AND fm.workspace_id=t.workspace_id LEFT JOIN users fu ON fu.id=fm.user_id
          WHERE t.workspace_id=$1 AND t.id=$2 AND t.valid_to IS NULL AND t.retracted_at IS NULL AND NOT t.scope_held AND ${ap.sql}
            AND crm_delivery_envelope_visible(t.workspace_id,t.user_id,t.assistant_id,t.sensitivity,t.compartments,t.project_ids,$${ap.nextIdx}::uuid) FOR SHARE OF t`,
          [workspaceId,taskId,...ap.params,viewer.chatId??null])).rows[0]
        if(work)linkedWork.push({id:link.id,kind:link.kind,title:goalTitle??work.title as string,status:goalStatus??work.status as string,taskId,
          executorLabel:work.executor as string|null,followUpLabel:work.followup as string|null})
      }
      // Recheck the base after evidence retrieval; no cached claim survives revocation.
      if (!(await executeRead(viewer.userId, `SELECT 1 FROM crm_delivery_commitments c WHERE c.workspace_id=$1 AND c.id=$2 AND c.version=$3 AND ${deliveryVisibility(viewer,workspaceId,'c',4).sql}`,
        [workspaceId,id,commitment.version,...deliveryVisibility(viewer,workspaceId,'c',4).params])).rows.length) return null
      return { commitment, observations, linkedWork, evidenceCursor: page.nextCursor,
        assessment: assessDelivery(commitment, observations, new Date().toISOString(), page.nextCursor !== null) } satisfies DeliveryDetail
    },
  }
}
