/** Explicit publication of prepared workflow text, not permission to read its sources. */
import { createHash } from 'node:crypto'
import {
  intersectAccessCeilings, type WorkflowRecord, type WorkflowRunStore, type WorkflowStore,
} from '@use-brian/core'
import { getPool, query } from '../db/client.js'
import type { PoolClient } from 'pg'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../db/workflow-store.js'
import { findAssistantById, getWorkspacePrimaryAssistant } from '../db/users.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { resolveLiveAccessCeilingSystem } from '../context-scope/resolve-turn-scope.js'
import { validateAudienceScopeEvidence } from '../context-scope/caller-evidence.js'
import {
  createDeliveryAudienceEnvelopeResolver, type DeliveryAudienceInput,
  type ResolveDeliveryAudienceEnvelope,
} from '../context-scope/delivery-authority.js'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'

export type PublicationContext = { runId: string; stepId: string }
export type PublicationConsent = {
  id: string; workflowId: string; workspaceId: string; stepId: string; approvedByUserId: string
  workflowRevision: string; channelType: 'telegram'; channelId: string; channelIntegrationId: string
  approvedAt: string; expiresAt: string; revokedAt: string | null
}
export type PublicationConsentStore = {
  list(workflowId: string, userId: string): Promise<PublicationConsent[]>
  version(workflowId: string, userId: string): Promise<string>
  approve(consent: Omit<PublicationConsent, 'id' | 'approvedAt' | 'revokedAt'>, expectedVersion: string): Promise<boolean>
  revoke(workflowId: string, stepId: string, userId: string): Promise<void>
  withPublicationLock<T>(workflowId: string, userId: string, action: () => Promise<T>): Promise<T>
  isStepRunning(runId: string, stepId: string): Promise<boolean>
}

type ConsentRow = {
  id: string; workflow_id: string; workspace_id: string; step_id: string; approved_by_user_id: string
  workflow_revision: string; channel_type: 'telegram'; channel_id: string; channel_integration_id: string
  approved_at: Date; expires_at: Date; revoked_at: Date | null
}
// A dispatch holds one connection while authority readers use the system pool.
// Reserve at least one reader slot instead of deadlocking a small self-host pool.
let activeLocks = 0
const lockWaiters: Array<() => void> = []
async function reserveLockConnection(): Promise<() => void> {
  const capacity = (getPool().options.max ?? 4) - 1
  if (capacity < 1) throw new Error('Workflow publication requires PG_POOL_MAX of at least 2')
  if (activeLocks >= capacity) await new Promise<void>(resolve => lockWaiters.push(resolve))
  else activeLocks++
  return () => {
    const next = lockWaiters.shift()
    if (next) next()
    else activeLocks--
  }
}
async function withConsentLock<T>(workflowId: string, userId: string, shared: boolean, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const releaseSlot = await reserveLockConnection()
  let client: PoolClient | undefined
  try {
    client = await getPool().connect()
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '10s'")
    await client.query(`SELECT ${shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}(hashtextextended($1,0))`,
      [`workflow-publication:${workflowId}:${userId}`])
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client?.release(); releaseSlot() }
}

export function createPublicationConsentStore(): PublicationConsentStore {
  return {
    async list(workflowId, userId) {
      const rows = await query<ConsentRow>(
        `SELECT * FROM workflow_publication_consents WHERE workflow_id=$1 AND approved_by_user_id=$2
         AND revoked_at IS NULL ORDER BY approved_at DESC`, [workflowId, userId])
      return rows.rows.map(r => ({ id: r.id, workflowId: r.workflow_id, workspaceId: r.workspace_id,
        stepId: r.step_id, approvedByUserId: r.approved_by_user_id, workflowRevision: r.workflow_revision,
        channelType: r.channel_type, channelId: r.channel_id, channelIntegrationId: r.channel_integration_id,
        approvedAt: r.approved_at.toISOString(), expiresAt: r.expires_at.toISOString(),
        revokedAt: r.revoked_at?.toISOString() ?? null }))
    },
    async version(workflowId, userId) {
      const result = await query<{ version: string }>(`SELECT version::text FROM workflow_publication_consent_states WHERE workflow_id=$1 AND user_id=$2`, [workflowId, userId])
      return result.rows[0]?.version ?? '0'
    },
    async approve(c, expectedVersion) {
      return withConsentLock(c.workflowId, c.approvedByUserId, false, async client => {
        await client.query(`INSERT INTO workflow_publication_consent_states(workflow_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [c.workflowId,c.approvedByUserId])
        const state = await client.query<{ version: string }>(`SELECT version::text FROM workflow_publication_consent_states WHERE workflow_id=$1 AND user_id=$2`, [c.workflowId,c.approvedByUserId])
        if (state.rows[0]?.version !== expectedVersion) return false
        await client.query(`UPDATE workflow_publication_consents SET revoked_at=clock_timestamp()
          WHERE workflow_id=$1 AND step_id=$2 AND approved_by_user_id=$3 AND revoked_at IS NULL`, [c.workflowId,c.stepId,c.approvedByUserId])
        await client.query(`INSERT INTO workflow_publication_consents
          (workflow_id,workspace_id,step_id,approved_by_user_id,workflow_revision,channel_type,channel_id,channel_integration_id,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [c.workflowId,c.workspaceId,c.stepId,c.approvedByUserId,c.workflowRevision,c.channelType,c.channelId,c.channelIntegrationId,c.expiresAt])
        await client.query(`UPDATE workflow_publication_consent_states SET version=version+1 WHERE workflow_id=$1 AND user_id=$2`, [c.workflowId,c.approvedByUserId])
        return true
      })
    },
    async revoke(workflowId, stepId, userId) {
      await withConsentLock(workflowId, userId, false, async client => {
        await client.query(`UPDATE workflow_publication_consents SET revoked_at=clock_timestamp()
          WHERE workflow_id=$1 AND step_id=$2 AND approved_by_user_id=$3 AND revoked_at IS NULL`, [workflowId, stepId, userId])
        await client.query(`INSERT INTO workflow_publication_consent_states(workflow_id,user_id,version) VALUES ($1,$2,1)
          ON CONFLICT (workflow_id,user_id) DO UPDATE SET version=workflow_publication_consent_states.version+1`, [workflowId,userId])
      })
    },
    withPublicationLock(workflowId, userId, action) {
      return withConsentLock(workflowId, userId, true, () => action())
    },
    async isStepRunning(runId, stepId) {
      const result = await query(`SELECT 1 FROM workflow_step_runs WHERE run_id=$1 AND step_id=$2 AND status='running' LIMIT 1`, [runId, stepId])
      return result.rows.length > 0
    },
  }
}

/** Any saved change invalidates consent, including edits through chat/tools. */
export function publicationRevision(workflow: WorkflowRecord): string {
  return createHash('sha256').update(JSON.stringify({
    updatedAt: workflow.updatedAt.toISOString(), definition: workflow.definition,
    authority: workflow.authoringAuthority, contextGroupId: workflow.contextGroupId,
    contextProjectId: workflow.contextProjectId, modelAlias: workflow.modelAlias,
    researchMode: workflow.researchMode, maxTurns: workflow.maxTurns,
  })).digest('hex')
}

export function publicationTarget(workflow: WorkflowRecord, stepId: string) {
  if (workflow.managedBy || workflow.definition.principal) return null
  const step = workflow.definition.steps.find(s => s.id === stepId)
  if (!step || step.type !== 'assistant_call' || step.question || step.questionResponse) return null
  const target = step.deliver
  if (!target || 'replyToTrigger' in target || target.channelType !== 'telegram'
    || !target.channelIntegrationId || !/^-\d+(?::topic:\d+)?$/.test(target.channelId)) return null
  return { channelType: 'telegram' as const, channelId: target.channelId,
    channelIntegrationId: target.channelIntegrationId }
}

export type AuthorizeWorkflowPublication = (input: DeliveryAudienceInput & {
  publication: PublicationContext
}) => Promise<{ allowed: true; approvalId: string } | { allowed: false }>

type Dependencies = {
  store?: PublicationConsentStore; workflowStore?: Pick<WorkflowStore, 'findByIdSystem'>
  runStore?: Pick<WorkflowRunStore, 'getRunSystem'>; integrationStore?: ChannelIntegrationStore
  resolveAudience?: ResolveDeliveryAudienceEnvelope; getRole?: typeof getWorkspaceRoleSystem
  findAssistant?: typeof findAssistantById; findPrimary?: typeof getWorkspacePrimaryAssistant
  resolveLiveAccess?: typeof resolveLiveAccessCeilingSystem
  validateEvidence?: typeof validateAudienceScopeEvidence; now?: () => number
  authorizePublication?: AuthorizeWorkflowPublication
}

/** Only a fixed, currently running generated-output step may exercise this consent. */
export function createWorkflowPublicationAuthorizer(deps: Dependencies = {}): AuthorizeWorkflowPublication {
  const store = deps.store ?? createPublicationConsentStore()
  const workflows = deps.workflowStore ?? createDbWorkflowStore()
  const runs = deps.runStore ?? createDbWorkflowRunStore()
  const audience = deps.resolveAudience ?? createDeliveryAudienceEnvelopeResolver({ integrationStore: deps.integrationStore })
  return async input => {
    try {
      if (input.scopeEvidence === undefined || input.sessionId || input.channelType !== 'telegram'
        || !input.channelIntegrationId || input.recipientMode === 'external' || input.recipientMode === 'assistant') return { allowed: false }
      const run = await runs.getRunSystem(input.publication.runId)
      if (!run || run.workspaceId !== input.workspaceId || run.status !== 'running'
        || !await store.isStepRunning(run.id, input.publication.stepId)) return { allowed: false }
      const workflow = await workflows.findByIdSystem(run.workflowId)
      if (!workflow || workflow.workspaceId !== input.workspaceId || workflow.createdBy !== input.userId
        || (run.triggeredBy ?? workflow.createdBy) !== input.userId) return { allowed: false }
      const step = workflow.definition.steps.find(s => s.id === input.publication.stepId)
      if (!step || step.type !== 'assistant_call') return { allowed: false }
      const expectedAssistantId = step.target.assistantId === 'primary'
        ? (await (deps.findPrimary ?? getWorkspacePrimaryAssistant)(input.userId, input.workspaceId))?.id
        : step.target.assistantId
      if (expectedAssistantId !== input.assistantId) return { allowed: false }
      const target = publicationTarget(workflow, input.publication.stepId)
      if (!target || target.channelId !== input.channelId || target.channelIntegrationId !== input.channelIntegrationId) return { allowed: false }
      const role = await (deps.getRole ?? getWorkspaceRoleSystem)(input.userId, input.workspaceId)
      if (role !== 'owner' && role !== 'admin') return { allowed: false }
      const now = (deps.now ?? Date.now)()
      const revision = publicationRevision(workflow)
      const consent = (await store.list(workflow.id, input.userId)).find(c => c.stepId === input.publication.stepId
        && c.workspaceId === input.workspaceId && c.approvedByUserId === input.userId
        && c.workflowRevision === revision && !c.revokedAt && c.channelType === input.channelType
        && c.channelId === input.channelId && c.channelIntegrationId === input.channelIntegrationId
        && Date.parse(c.expiresAt) > now && Date.parse(c.approvedAt) < run.startedAt.getTime())
      if (!consent) return { allowed: false }
      const envelope = await audience(input)
      // Explicit audience approval is still required. This exception changes
      // publication of the owner's personal context, not clearance/Team/Project grants.
      if (!envelope.allowed || envelope.source !== 'binding'
        || (envelope.ceiling.userId && envelope.ceiling.userId !== input.userId)) return { allowed: false }
      const assistant = await (deps.findAssistant ?? findAssistantById)(input.assistantId)
      if (!assistant || assistant.workspaceId !== input.workspaceId) return { allowed: false }
      const live = await (deps.resolveLiveAccess ?? resolveLiveAccessCeilingSystem)({
        userId: input.userId, assistant, workspaceId: input.workspaceId,
      })
      const ceiling = intersectAccessCeilings(live, { ...envelope.ceiling, userId: input.userId })
      // Preserve and revalidate ALL evidence, including current source state;
      // another person's private rows, held sources, and revoked access still fail.
      await (deps.validateEvidence ?? validateAudienceScopeEvidence)(input.scopeEvidence, ceiling)
      // Evidence validation may await source reads. Do not use consent, role,
      // run state or a workflow revision captured before those awaits.
      const latestWorkflow = await workflows.findByIdSystem(workflow.id)
      const latestRun = await runs.getRunSystem(run.id)
      const latestRole = await (deps.getRole ?? getWorkspaceRoleSystem)(input.userId, input.workspaceId)
      const latestConsent = (await store.list(workflow.id, input.userId)).find(c => c.id === consent.id)
      if (!latestWorkflow || publicationRevision(latestWorkflow) !== revision || latestWorkflow.createdBy !== input.userId
        || !latestRun || latestRun.status !== 'running' || (latestRun.triggeredBy ?? latestWorkflow.createdBy) !== input.userId
        || !await store.isStepRunning(run.id, input.publication.stepId)
        || (latestRole !== 'owner' && latestRole !== 'admin') || !latestConsent || latestConsent.revokedAt
        || Date.parse(latestConsent.expiresAt) <= (deps.now ?? Date.now)()) return { allowed: false }
      return { allowed: true, approvalId: consent.id }
    } catch {
      return { allowed: false }
    }
  }
}

export type DispatchWorkflowPublication = (
  input: DeliveryAudienceInput & { publication: PublicationContext }, approvalId: string,
  send: () => Promise<string | void>,
) => Promise<{ allowed: true; messageId: string | void } | { allowed: false }>

/** Shared dispatch lock vs exclusive approve/revoke: once withdrawal returns,
 * no future provider send can exercise the old consent. An already dispatching
 * send may finish first. Telegram calls never move outside this boundary. */
export function createWorkflowPublicationDispatcher(deps: Dependencies = {}): DispatchWorkflowPublication {
  const store = deps.store ?? createPublicationConsentStore()
  const runs = deps.runStore ?? createDbWorkflowRunStore()
  const authorize = deps.authorizePublication ?? createWorkflowPublicationAuthorizer({ ...deps, store, runStore: runs })
  return async (input, approvalId, send) => {
    const run = await runs.getRunSystem(input.publication.runId)
    if (!run || run.workspaceId !== input.workspaceId) return { allowed: false }
    return store.withPublicationLock(run.workflowId, input.userId, async () => {
      const decision = await authorize(input)
      if (!decision.allowed || decision.approvalId !== approvalId) return { allowed: false }
      return { allowed: true, messageId: await send() }
    })
  }
}
