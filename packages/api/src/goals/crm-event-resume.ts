/** Canonical CRM event admission for parked goals. [COMP:api/goal-crm-scope] */
import { crmDomainEventToDispatchEvent, matchesEvent, type CrmDomainEventEnvelope, type DispatchEvent, type GoalRecord } from '@use-brian/core'
import { getPool, query } from '../db/client.js'
import { acquireCrmPrivacyWriterAdmission } from '../crm-operations/privacy-admission.js'
import type { GoalAwaitingEvent } from './driver.js'

export async function claimCrmGoalEventResume(goalId: string, event: DispatchEvent, marker: GoalAwaitingEvent): Promise<boolean> {
  const eventId=event.payload.domainEventId
  if(event.source.type!=='crm'||typeof eventId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId))
    throw new Error('goal_source_scope_unavailable')
  const client=await getPool().connect()
  try {
    await client.query('BEGIN')
    await acquireCrmPrivacyWriterAdmission(client,event.workspaceId)
    // Reload the event rather than trusting dispatcher payload fields or labels.
    const stored=(await client.query<CrmDomainEventEnvelope>(`SELECT id,workspace_id AS "workspaceId",event_type AS "eventType",
      subject_kind AS "subjectKind",subject_id AS "subjectId",payload,actor_kind AS "actorKind",occurred_at AS "occurredAt"
      FROM crm_domain_event_outbox WHERE id=$1 AND workspace_id=$2 AND status<>'retired'`,[eventId,event.workspaceId])).rows[0]
    if(!stored||!marker.subscriptions.some(subscription=>matchesEvent(crmDomainEventToDispatchEvent(stored),subscription))) {
      await client.query('COMMIT');return false
    }
    const result=await client.query<{claimed:boolean}>('SELECT claim_crm_goal_resume($1,$2,$3,$4::jsonb) AS claimed',
      [goalId,eventId,event.workspaceId,JSON.stringify(marker)])
    await client.query('COMMIT')
    return result.rows[0]?.claimed===true
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
  finally{client.release()}
}

export async function assertGoalCrmSourceAuthority(goal: GoalRecord): Promise<void> {
  const allowed=(await query<{allowed:boolean}>('SELECT goal_crm_execution_allows($1) AS allowed',[goal.id])).rows[0]?.allowed
  if(!allowed)throw Object.assign(new Error('goal_source_scope_unavailable'),{code:'goal_source_scope_unavailable'})
}
