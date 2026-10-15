/** Canonical delivery commands bound to the existing CRM transaction.
 * [COMP:api/crm-delivery-oversight]
 */
import { CrmOperationsError, classifyDeliveryRecognition, deliveryQuoteMatches, deliveryObservationSupported,
  type DeliveryCommand, type DeliveryCommitment, type DeliverySource, type DeliveryViewer } from '@use-brian/core'
import type { CrmOperationsTransaction } from '../db/crm-operations-store.js'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { mutationActorAccess } from '../db/access-predicate.js'
import { applyRLSGucs } from '../db/client.js'
import { DELIVERY_COMMITMENT_COLUMNS, deliveryCommitmentRow, deliveryLinkVisible, deliveryVisibility,
  readDeliverySource } from '../db/crm-delivery-oversight-store.js'
import { actorColumns, commercialAudit, commercialResult, unavailable, withOperationReceipt } from './commercial-transaction.js'

function invalid(message: string): never { throw new CrmOperationsError('invalid_input', message) }
function conflict(): never { throw new CrmOperationsError('conflict', 'The delivery projection changed. Reload before reviewing it.') }
function assertVersion(c: DeliveryCommitment, version: number) { if (c.version !== version) conflict() }

/** This seam admits real sources/links before receipts and writes. */
export async function executeDeliveryCommand(tx: CrmOperationsTransaction, command: DeliveryCommand) {
  const { client, context } = tx.commercial()
  const parent=context.authority.deliveryCredentialParent
  let access
  if(['brain_key','oauth_token','home_app'].includes(context.actor.kind)) {
    const ambient=currentAgentAccess()
    const kind=context.actor.kind
    const reader=kind==='brain_key'?'crm_brain_parent_current':kind==='oauth_token'?'crm_oauth_parent_current':'crm_home_app_parent_current'
    const proofCurrent=parent?.kind==='oauth_token'
      ? await client.query<{current:boolean}>('SELECT crm_oauth_parent_current($1,$2,$3,$4,$5,$6) AS current',[parent.credentialId,parent.workspaceId,parent.userId,parent.clientId,parent.expiresAt,parent.tokenFingerprint])
      : parent ? await client.query<{current:boolean}>(`SELECT ${reader}($1::jsonb) AS current`,[JSON.stringify(parent)]) : null
    if(!parent||parent.kind!==kind||!('credentialId' in context.actor)||parent.credentialId!==context.actor.credentialId
      ||parent.workspaceId!==context.workspaceId||!ambient||ambient.workspaceId!==context.workspaceId||ambient.userId!==parent.userId
      ||ambient.compartments===undefined||ambient.mutationCompartments===undefined||ambient.projectIds===undefined
      ||!proofCurrent?.rows[0]?.current) {
      throw new CrmOperationsError('not_authorized','The current authenticated credential and native source ceiling are required.')
    }
    access=mutationActorAccess(parent.userId,context.workspaceId,{...ambient,userId:parent.userId,workspaceId:context.workspaceId,assistantId:'',assistantKind:'primary'})
  } else access = await tx.commercial().actorAccess()
  await applyRLSGucs(client, access.userId)
  const viewer: DeliveryViewer = { userId: access.userId, access, ...(context.actor.kind==='assistant'?{chatId:context.actor.sessionId}:{}) }
  const identity = actorColumns(context)
  let reviewerUserId=context.actor.kind==='user'?context.actor.userId:null
  if (command.kind === 'review_delivery_recognition' && context.actor.kind !== 'user') {
    const proof=context.authority.deliveryReviewApproval
    const {kind:ignored,...input}=command
    if(context.actor.kind!=='assistant'||!proof||proof.approverUserId!==access.userId||!(await client.query(`SELECT id FROM pending_approvals
      WHERE id=$1 AND workspace_id=$2 AND kind='tool_invocation' AND status='approved' AND responded_by=$3
        AND approver_user_id=$3 AND blocking_session_id=$4 AND tool_name='reviewCrmDeliveryRecognition' AND arguments=$5::jsonb
        AND originating_assistant_id=$6 AND (expires_at IS NULL OR responded_at<=expires_at) FOR SHARE`,
      [proof?.approvalId,context.workspaceId,access.userId,context.actor.kind==='assistant'?context.actor.sessionId:null,JSON.stringify(input),context.actor.kind==='assistant'?context.actor.assistantId:null])).rowCount) {
      throw new CrmOperationsError('not_authorized', 'An exact attended human review approval is required for this source interpretation.')
    }
    reviewerUserId=proof.approverUserId
  }
  let current: DeliveryCommitment | null = null
  let source: DeliverySource
  if (command.kind === 'record_delivery_recognition') {
    const admitted = await readDeliverySource(client, viewer, context.workspaceId, command.proposal.source)
    if (!admitted) unavailable()
    source = admitted
    if (!deliveryQuoteMatches(command.proposal.source, source)) invalid('The quote must match the exact current source selector.')
    for (const id of [command.proposal.companyId, command.proposal.dealId].filter((v): v is string => Boolean(v))) {
      if (!await deliveryLinkVisible(client, viewer, context.workspaceId, 'entity', id)) unavailable()
    }
    for (const [kind, ids] of [['task', command.proposal.taskIds], ['goal', command.proposal.goalIds]] as const) {
      for (const id of ids) if (!await deliveryLinkVisible(client, viewer, context.workspaceId, kind, id)) unavailable()
    }
  } else {
    const visibility = deliveryVisibility(viewer, context.workspaceId, 'c', 3, 'mutation')
    const row = (await client.query(`SELECT ${DELIVERY_COMMITMENT_COLUMNS} FROM crm_delivery_commitments c
      WHERE c.workspace_id=$1 AND c.id=$2 AND ${visibility.sql} FOR UPDATE OF c`, [context.workspaceId, command.commitmentId, ...visibility.params])).rows[0]
    if (!row) unavailable()
    current = deliveryCommitmentRow(row)
    const admitted = await readDeliverySource(client, viewer, context.workspaceId, current.source)
    if (!admitted) unavailable()
    source = admitted
  }
  const outcome = await withOperationReceipt(tx, command, async () => {
    let commitmentId: string
    let action: string
    let reason: string | null = null
    if (command.kind === 'record_delivery_recognition') {
      const proposal = command.proposal
      // Serialize source/candidate identity across distinct operation ids.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`delivery:${context.workspaceId}:${source.kind}:${source.id}:${proposal.candidateKey}`])
      const prior = (await client.query(`SELECT ${DELIVERY_COMMITMENT_COLUMNS},c.request_hash AS "requestHash" FROM crm_delivery_commitments c
        WHERE c.workspace_id=$1 AND c.source_kind=$2 AND c.source_id=$3 AND c.source_revision=$4 AND c.candidate_key=$5 FOR UPDATE`,
        [context.workspaceId, source.kind, source.id, source.revision, proposal.candidateKey])).rows[0]
      const { crmOperationsSha256 } = await import('@use-brian/core')
      const requestHash = crmOperationsSha256(proposal)
      if (prior) {
        if (prior.requestHash !== requestHash) throw new CrmOperationsError('idempotency_conflict', 'The frozen source candidate already has a different payload.')
        return commercialResult(command.kind, { id: prior.id, version: prior.version }, { duplicate: true })
      }
      const recognition = classifyDeliveryRecognition(proposal, source)
      // Calendar projection requires exact source evidence, never the model's date guess.
      const dueDate = proposal.dueDate && source.quote.includes(proposal.dueDate) ? proposal.dueDate : null
      const superseded=await client.query(`UPDATE crm_delivery_commitments SET recognition_state='superseded',version=version+1,updated_at=now()
        WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 AND candidate_key=$4 AND source_revision<>$5 AND recognition_state<>'superseded'
        RETURNING id,version,source_revision`,[context.workspaceId,source.kind,source.id,proposal.candidateKey,source.revision])
      for(const prior of superseded.rows)await client.query(`INSERT INTO crm_delivery_history(workspace_id,commitment_id,version,operation_id,action,actor_kind,actor_id,source_revision)
        VALUES($1,$2,$3,$4,'superseded',$5,$6,$7)`,[context.workspaceId,prior.id,prior.version,command.operationId,identity.kind,identity.id,prior.source_revision])
      commitmentId = (await client.query<{ id: string }>(`INSERT INTO crm_delivery_commitments(workspace_id,candidate_key,source_kind,source_id,source_revision,source_selector,
        outcome,due_date,company_id,deal_id,task_ids,goal_ids,agreeing_user_id,recognition_state,recognition_reason,origin_chat_id,
        user_id,assistant_id,sensitivity,compartments,project_ids,request_hash)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
        [context.workspaceId, proposal.candidateKey, source.kind, source.id, source.revision, JSON.stringify(proposal.source), proposal.outcome, dueDate,
          proposal.companyId, proposal.dealId, proposal.taskIds, proposal.goalIds, recognition.agreeingUserId, recognition.state, recognition.reason,
          source.originChatId, source.userId, source.assistantId, source.sensitivity, source.compartments, source.projectIds, requestHash])).rows[0]!.id
      action = 'recorded'
    } else {
      commitmentId = current!.id
      assertVersion(current!, command.expectedVersion)
      if (command.kind === 'review_delivery_recognition') {
        if (!deliveryQuoteMatches(current!.source, source)) unavailable()
        const state = command.decision === 'dismiss' ? 'dismissed' : 'recognised'
        // Human interpretation stays evidence-bound. Review cannot accept assistant drafts.
        if (state === 'recognised' && (source.role === 'assistant' || source.archive)) invalid('Assistant drafts are not agreement evidence.')
        await client.query(`UPDATE crm_delivery_commitments SET recognition_state=$3,recognition_reason='human_review',
          outcome=coalesce($4,outcome),version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
          [context.workspaceId, commitmentId, state, command.outcome ?? null])
        reason = command.reason; action = command.decision
      } else if (command.kind === 'append_delivery_observation') {
        const input = command.observation
        const observed = await readDeliverySource(client, viewer, context.workspaceId, input.source)
        if (!observed || !deliveryQuoteMatches(input.source, observed)) unavailable()
        if (!deliveryObservationSupported(input,observed,current!.outcome)) invalid('The current exact evidence cannot support that delivery claim. Keep it unknown or review the source.')
        if (input.kind === 'human_report' && (observed.role !== 'human' || !observed.authorUserId)) invalid('A human report requires an authenticated native sender.')
        if (input.kind === 'observed_fact' && observed.role !== 'document' && observed.role !== 'governed') invalid('Assistant replies and human completion reports are not independently observed delivery.')
        if (input.kind === 'coverage_gap' && input.claim !== 'unknown') invalid('A visibility gap cannot diagnose delivery.')
        if (input.claim === 'outcome_delivered' && input.kind !== 'observed_fact') invalid('A report cannot assert independently verified delivery.')
        if (input.workId && !current!.taskIds.includes(input.workId) && !current!.goalIds.includes(input.workId)) invalid('Next actions can only reference already linked work.')
        if (input.workId && !await deliveryLinkVisible(client, viewer, context.workspaceId, current!.taskIds.includes(input.workId) ? 'task' : 'goal', input.workId)) unavailable()
        await client.query(`INSERT INTO crm_delivery_observations(workspace_id,commitment_id,source_kind,source_id,source_revision,source_selector,kind,claim,statement,
          work_id,reporter_user_id,occurred_at,user_id,assistant_id,sensitivity,compartments,project_ids)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [context.workspaceId, commitmentId, observed.kind, observed.id, observed.revision, JSON.stringify(input.source), input.kind,input.claim,input.statement,
            input.workId,input.kind === 'human_report' ? observed.authorUserId : null,observed.occurredAt,observed.userId,observed.assistantId,
            observed.sensitivity,observed.compartments,observed.projectIds])
        await client.query('UPDATE crm_delivery_commitments SET version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2', [context.workspaceId, commitmentId])
        action = 'observation_added'
      } else if (command.kind === 'withdraw_delivery_observation') {
        const visible = deliveryVisibility(viewer, context.workspaceId, 'o', 4, 'mutation')
        const changed = await client.query(`UPDATE crm_delivery_observations o SET withdrawn_at=now() WHERE o.workspace_id=$1 AND o.commitment_id=$2 AND o.id=$3
          AND o.withdrawn_at IS NULL AND ${visible.sql} RETURNING id`, [context.workspaceId, commitmentId, command.observationId, ...visible.params])
        if (!changed.rowCount) unavailable()
        await client.query('UPDATE crm_delivery_commitments SET version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2', [context.workspaceId, commitmentId])
        reason=command.reason; action='observation_withdrawn'
      } else {
        // Assessment is always a derived current read. No model, durable risk
        // field, resynthesis, timers or per-read automatic allowance.
        return commercialResult(command.kind, { id: commitmentId, version: current!.version })
      }
    }
    const version = (await client.query<{ version: number }>('SELECT version FROM crm_delivery_commitments WHERE id=$1', [commitmentId])).rows[0]!.version
    await client.query(`INSERT INTO crm_delivery_history(workspace_id,commitment_id,version,operation_id,action,actor_kind,actor_id,reason,source_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [context.workspaceId,commitmentId,version,command.operationId,action,command.kind==='review_delivery_recognition'?'user':identity.kind,command.kind==='review_delivery_recognition'?reviewerUserId:identity.id,reason,source.revision])
    await commercialAudit(tx, context, { action: `crm.delivery_projection.${action}`, subjectKind: 'delivery_commitment', subjectId: commitmentId,
      details: { version, sourceRevision: source.revision, ...(command.kind==='review_delivery_recognition'?{reviewerUserId}:{}) } })
    // A content-free cache invalidation event, never a workflow trigger or alert.
    const eventId = await tx.emitDomainEvent({ eventType: 'crm.delivery_projection.changed', eventKey: `crm.delivery_projection.changed:${commitmentId}:${version}`,
      subjectKind: 'delivery_commitment', subjectId: commitmentId, payload: { commitmentId, version }, actor: context.actor, occurredAt: new Date().toISOString() })
    return commercialResult(command.kind, { id: commitmentId, version }, { created: command.kind === 'record_delivery_recognition', emittedEventIds: [eventId] })
  })
  // Receipts contain ids/versions only, never persuasive cached assessment text.
  return outcome
}
