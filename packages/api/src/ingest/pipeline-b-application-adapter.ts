/** Transaction-bound interpreter for frozen Pipeline B commands. */
import type pg from 'pg'
import {
  DROPPED_CANDIDATE_TTL_DAYS,
  admitTask,
  isPipelineBApplicationCommand,
  type PipelineBApplicationCommand,
  type PipelineBEntityApplication,
} from '@use-brian/core'

import { createCompany, createContact, type CrmWriteTransaction } from '../db/crm.js'
import { createEntityLink } from '../db/entity-links-store.js'
import {
  addEntityAlias,
  createEntity,
  getEntityByIdSystem,
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
  client: pg.PoolClient,
): Promise<string> {
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
    case 'supersede_entity': {
      if (!payload.targetEntityId) throw Object.assign(new Error('missing entity target'), { code: 'application_target_missing', retryable: false })
      const entity = await supersedeEntity(actor, payload.targetEntityId, {
        attributes: payload.attributes,
        sourceEpisodeId: payload.episodeId,
        compartments: payload.compartments,
        projectIds: payload.projectIds,
      }, client)
      if (!entity) throw Object.assign(new Error('entity target changed'), { code: 'application_target_changed', retryable: false })
      id = entity.id
      break
    }
    case 'reuse_entity': {
      if (!payload.targetEntityId) throw Object.assign(new Error('missing entity target'), { code: 'application_target_missing', retryable: false })
      const entity = await getEntityByIdSystem(actor, payload.targetEntityId, {}, client)
      if (!entity) throw Object.assign(new Error('entity target changed'), { code: 'application_target_changed', retryable: false })
      id = entity.id
      break
    }
  }
  if (payload.alias) {
    const alias = await addEntityAlias(actor, id, payload.alias, undefined, client)
    if (alias.kind === 'conflict') {
      throw Object.assign(new Error('entity alias now conflicts'), { code: 'application_policy_changed', retryable: false })
    }
  }
  return id
}

export function createPipelineBApplicationMutationPort(): ExtractionCandidateMutationPort {
  return async ({ candidate, dependencies, transactionContext }) => {
    const client = transaction(transactionContext)
    const payload = command(candidate.payload)
    switch (payload.command) {
      case 'entity':
        return { targetRecordId: await applyEntity(payload, client) }
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
