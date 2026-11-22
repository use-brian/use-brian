/** Transaction-bound interpreter for frozen Pipeline B commands. */
import type pg from 'pg'
import { createHash } from 'node:crypto'
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import type { ExtractionApplicationMutation } from '@use-brian/core/ingest/application.js'
import type { FrozenExtractionPlan } from '@use-brian/core/ingest/extraction-plan.js'
import { createCrmOperationsService } from '../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../db/crm-operations-store.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import {
  isPipelineBApplicationCommand,
  type PipelineBApplicationCommand,
  type PipelineBEntityApplication,
} from '@use-brian/core/ingest/pipeline-b-application.js'
import { DROPPED_CANDIDATE_TTL_DAYS, admitTask } from '@use-brian/core/tasks/admission.js'

import { createCompany, createContact, type CrmWriteTransaction } from '../db/crm.js'
import { createEntityLink } from '../db/entity-links-store.js'
import {
  addEntityAlias,
  createEntity,
  inspectExtractionEntityTarget,
  supersedeEntity,
} from '../db/entities-store.js'
import { createMemory } from '../db/memories.js'
import { createTaskAdmissionPort } from '../db/task-admission-store.js'
import { createTask } from '../db/tasks.js'
import type { ExtractionCandidateMutationPort } from './application-service.js'

function transaction(context: unknown): pg.PoolClient {
  if (!context || typeof context !== 'object' || typeof (context as pg.PoolClient).query !== 'function') {
    throw Object.assign(new Error('application transaction is unavailable'), {
      code: 'application_transaction_missing', retryable: false,
    })
  }
  return context as pg.PoolClient
}

function command(value: unknown): PipelineBApplicationCommand {
  if (!isPipelineBApplicationCommand(value)) {
    throw Object.assign(new Error('frozen Pipeline B command is invalid'), {
      code: 'application_payload_invalid', retryable: false,
    })
  }
  return value
}

async function applyEntity(
  payload: PipelineBEntityApplication,
  actorAccess: AccessContext,
  client: pg.PoolClient,
): Promise<ExtractionApplicationMutation> {
  const actor = payload.createdByUserId
  const crmTransaction: CrmWriteTransaction = { client, afterCommit() {} }
  let id: string
  switch (payload.action) {
    case 'create_contact': {
      const contact = await createContact(actor, {
        workspaceId: payload.workspaceId,
        name: payload.displayName,
        email: payload.canonicalId,
        phone: payload.phone ?? null,
        externalRef: payload.externalRef ?? undefined,
        stableIdentity: payload.stableIdentity ?? undefined,
        sensitivity: payload.sensitivity,
        source: 'extracted',
        sourceEpisodeId: payload.episodeId,
        createdByAssistantId: payload.createdByAssistantId,
        compartments: payload.compartments,
        projectIds: payload.projectIds,
      }, undefined, crmTransaction)
      id = contact.id
      break
    }
    case 'create_company': {
      const company = await createCompany(actor, {
        workspaceId: payload.workspaceId,
        name: payload.displayName,
        domain: payload.canonicalId,
        sensitivity: payload.sensitivity,
        source: 'extracted',
        sourceEpisodeId: payload.episodeId,
        createdByAssistantId: payload.createdByAssistantId,
        compartments: payload.compartments,
        projectIds: payload.projectIds,
      }, crmTransaction)
      id = company.id
      break
    }
    case 'create_entity': {
      const entity = await createEntity({
        derivation: payload.derivation,
        kind: payload.entityKind,
        displayName: payload.displayName,
        canonicalId: payload.canonicalId,
        attributes: payload.attributes,
        workspaceId: payload.workspaceId,
        userId: payload.userId,
        assistantId: payload.assistantId,
        createdByUserId: actor,
        createdByAssistantId: payload.createdByAssistantId,
        sourceEpisodeId: payload.episodeId,
        sensitivity: payload.sensitivity,
        compartments: payload.compartments,
        projectIds: payload.projectIds,
        source: 'extracted',
      }, client)
      id = entity.id
      break
    }
    case 'supersede_entity':
    case 'reuse_entity': {
      return applyExistingEntity(payload, actorAccess, client)
    }
  }
  return { targetRecordId: id }
}

async function applyExistingEntity(
  payload: PipelineBEntityApplication,
  actorAccess: AccessContext,
  client: pg.PoolClient,
): Promise<ExtractionApplicationMutation> {
  if (!payload.targetEntityId) return { disposition: 'held', safeCode: 'application_target_missing' }
  const actor = payload.createdByUserId
  const access: AccessContext = {
    workspaceId: payload.workspaceId,
    userId: actor,
    assistantId: payload.assistantId ?? '',
    assistantKind: 'primary',
    visibilityAssistantIds: payload.assistantId ? [payload.assistantId] : [],
    sharedAudience: payload.userId === null,
    clearance: payload.sensitivity,
    compartments: payload.compartments,
    mutationCompartments: payload.compartments,
    projectIds: payload.projectIds,
  }
  const reuse = payload.action === 'reuse_entity'
  const normalizedName = payload.displayName.trim().toLowerCase()
  const alias = payload.alias?.trim().toLowerCase() ?? ''
  const learnableAlias = alias === normalizedName && alias.length > 0 && alias.length <= 200
  if (learnableAlias) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      JSON.stringify(['pipeline-b-alias', payload.workspaceId, alias]),
    ])
  }
  if (!reuse) {
    // Match the canonical supersession writer's workspace-before-entity lock order.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [payload.workspaceId])
  }
  const target = await inspectExtractionEntityTarget(access, actorAccess, {
    id: payload.targetEntityId, kind: payload.entityKind, canonicalId: payload.canonicalId, normalizedName,
  }, client)
  if (!target) return { disposition: 'held', safeCode: 'application_target_changed' }

  const canonicalIdentity = payload.canonicalId !== null && target.canonicalId === payload.canonicalId
    && !target.canonicalConflict
  if (!canonicalIdentity && (target.nameConflict || target.canonicalConflict
    || (payload.canonicalId !== null && target.canonicalId !== null)
    || (!target.nameMatch && !learnableAlias))) {
    return { disposition: 'held', safeCode: 'application_entity_identity_ambiguous' }
  }

  // An alias refusal on weak evidence must roll back the whole entity change.
  // A savepoint retains the enclosing item transaction so it can write a held receipt.
  const savepoint = !reuse && learnableAlias
  if (savepoint) await client.query('SAVEPOINT extraction_entity_alias')
  let id = payload.targetEntityId
  if (!reuse) {
    const entity = await supersedeEntity(actor, id, {
      attributes: payload.attributes,
      sourceEpisodeId: payload.episodeId,
      compartments: payload.compartments,
      projectIds: payload.projectIds,
    }, client, access)
    if (!entity) return { disposition: 'held', safeCode: 'application_target_changed' }
    id = entity.id
  }
  if (learnableAlias) {
    const result = await addEntityAlias(actor, id, alias, access, client)
    if (result.kind === 'not_found' || (result.kind === 'conflict' && !canonicalIdentity)) {
      if (savepoint) await client.query('ROLLBACK TO SAVEPOINT extraction_entity_alias')
      return {
        disposition: 'held',
        safeCode: result.kind === 'conflict' ? 'application_entity_alias_conflict' : 'application_target_changed',
      }
    }
  }
  if (savepoint) await client.query('RELEASE SAVEPOINT extraction_entity_alias')
  return { targetRecordId: id }
}

function hasAmbiguousEdgeReference(plan: FrozenExtractionPlan, endpointIds: string[]): boolean {
  const entities = plan.candidates.filter((candidate) => candidate.primitiveKind === 'entity')
  return entities.some((endpoint) => endpointIds.includes(endpoint.candidateId)
    && typeof endpoint.payload.displayName === 'string'
    && entities.some((other) => other.candidateId !== endpoint.candidateId
      && other.payload.displayName === endpoint.payload.displayName))
}

export function createPipelineBApplicationMutationPort(): ExtractionCandidateMutationPort {
  return async ({ candidate, dependencies, transactionContext, actorAccess, plan }) => {
    const client = transaction(transactionContext)
    const payload = command(candidate.payload)
    switch (payload.command) {
      case 'delivery_commitment': {
        const member=(await client.query<{role:'owner'|'admin'|'member'}>('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',
          [payload.workspaceId,payload.createdByUserId])).rows[0]
        if(!member) return {disposition:'held',safeCode:'delivery_source_unavailable',targetRecordId:null}
        const digest=createHash('sha256').update(`${payload.episodeId}:${candidate.candidateId}:${candidate.payloadHash}`).digest('hex')
        const operationId=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`
        try {
          const saved=await runWithAgentAccess({workspaceId:payload.workspaceId,userId:payload.createdByUserId,
            clearance:payload.sensitivity,compartments:payload.compartments,mutationCompartments:payload.compartments,
            projectIds:payload.projectIds,visibilityAssistantIds:payload.assistantId?[payload.assistantId]:null},
            ()=>createCrmOperationsService(createDbCrmOperationsStore(undefined,client)).execute({workspaceId:payload.workspaceId,
              actor:{kind:'import',jobId:payload.episodeId,userId:payload.createdByUserId},
              authority:{role:member.role,canWrite:true,canConfigure:false,trustedIdentitySources:[]}},
              {kind:'record_delivery_recognition',operationId,proposal:payload.proposal}))
          return {targetRecordId:saved.record.id as string}
        } catch(error) {
          // A typed unavailable/invalid proposal is a terminal gap; the application
          // ledger freezes that result and never renews a model/read allowance.
          if(error && typeof error==='object' && 'code' in error && ['not_found','not_authorized','invalid_input','idempotency_conflict'].includes(String(error.code))) {
            return {disposition:'held',safeCode:'delivery_source_unavailable',targetRecordId:null}
          }
          throw error
        }
      }
      case 'entity':
        return applyEntity(payload, actorAccess, client)
      case 'memory':
      case 'digest_memory': {
        const memory = await createMemory({
          assistantId: payload.assistantId!,
          userId: payload.userId,
          scope: payload.scope,
          tags: payload.tags,
          summary: payload.summary,
          detail: payload.detail ?? undefined,
          source: 'extracted',
          workspaceId: payload.workspaceId,
          sensitivity: payload.sensitivity,
          createdByUserId: payload.createdByUserId,
          createdByAssistantId: payload.createdByAssistantId ?? undefined,
          sourceEpisodeId: payload.episodeId,
          compartments: payload.compartments,
          projectIds: payload.projectIds,
        }, undefined, client)
        return { targetRecordId: memory.id }
      }
      case 'edge':
      case 'digest_edge': {
        if (payload.command === 'edge' && hasAmbiguousEdgeReference(plan, candidate.dependencyIds)) {
          return { disposition: 'held', safeCode: 'ambiguous_entity_reference' }
        }
        const sourceDependencyId = candidate.dependencyIds[payload.sourceDependencyIndex]
        const targetDependencyId = payload.targetDependencyIndex === null
          ? null
          : candidate.dependencyIds[payload.targetDependencyIndex]
        const sourceId = sourceDependencyId
          ? dependencies.get(sourceDependencyId)?.targetRecordId
          : null
        const targetId = targetDependencyId
          ? dependencies.get(targetDependencyId)?.targetRecordId
          : payload.targetRecordId
        if (!sourceId || !targetId) {
          throw Object.assign(new Error('edge dependency is unavailable'), {
            code: 'application_dependency_pending', retryable: true,
          })
        }
        const edge = await createEntityLink(payload.createdByUserId, {
          sourceKind: payload.sourceKind,
          sourceId,
          targetKind: payload.targetKind,
          targetId,
          edgeType: payload.edgeType as never,
          attributes: payload.attributes,
          source: 'extracted',
          sensitivity: payload.sensitivity,
          workspaceId: payload.workspaceId,
          userId: payload.userId,
          assistantId: payload.assistantId,
          sourceEpisodeId: payload.episodeId,
          compartments: payload.compartments,
          projectIds: payload.projectIds,
        }, client)
        return { targetRecordId: edge.id }
      }
      case 'task': {
        const due = payload.dueIso ? new Date(payload.dueIso) : null
        const admissionPort = createTaskAdmissionPort(client)
        const admission = await admitTask(admissionPort, {
          workspaceId: payload.workspaceId,
          title: payload.title,
          due,
          lane: 'extracted',
          sourceKind: payload.sourceKind,
          channelRef: payload.channelRef,
          sourceEpisodeId: payload.episodeId,
          createdByAssistantId: payload.createdByAssistantId,
          quality: payload.quality,
        })
        if (admission.outcome !== 'allow') {
          return {
            disposition: admission.outcome === 'hold' ? 'held' : 'rejected',
            safeCode: admission.reasonCode,
          }
        }
        const task = await createTask(payload.createdByUserId, {
          workspaceId: payload.workspaceId,
          title: payload.title,
          due,
          attributes: payload.quality?.description
            ? { description: payload.quality.description }
            : undefined,
          sensitivity: payload.sensitivity,
          visibility: { userId: payload.userId, assistantId: payload.assistantId },
          source: 'extracted',
          sourceEpisodeId: payload.episodeId,
          createdByAssistantId: payload.createdByAssistantId,
          compartments: payload.compartments,
          projectIds: payload.projectIds,
        }, undefined, client)
        if (admission.autoRuleId) {
          await admissionPort.recordCandidate({
            workspaceId: payload.workspaceId,
            title: payload.title,
            due,
            lane: 'extracted',
            sourceKind: payload.sourceKind,
            channelRef: payload.channelRef,
            sourceEpisodeId: payload.episodeId,
            createdByAssistantId: payload.createdByAssistantId,
            status: 'auto_accepted',
            reasonCode: 'auto_rule',
            matchedRuleId: admission.autoRuleId,
            quality: payload.quality,
            createdTaskId: task.id,
            expiresAt: new Date(Date.now() + DROPPED_CANDIDATE_TTL_DAYS * 24 * 60 * 60 * 1000),
          })
        }
        return { targetRecordId: task.id }
      }
      case 'episode_finalization':
        return { targetRecordId: payload.episodeId }
    }
  }
}
