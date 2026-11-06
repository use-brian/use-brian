import { restoreWorkspaceMcpDelegation } from '../workspace-mcp/delegation.js'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { bindWorkspaceMcpPublication } from '../db/session-context-revisions.js'
import { assertSourceModelInputAuthority } from '../application-platform/model-source-authority.js'
import { intersectAccessCeilings, AuthoritySourceSchema, pinAccessCeiling, parseAuthoringAuthority, type CurrentAuthorityBoundary, type SandboxTaskRecord } from '@use-brian/core'
import { createAuthorityLease, createSessionAuthorityLease } from '../context-scope/authority-lease.js'
import { resolveLiveAccessCeilingSystem } from '../context-scope/resolve-turn-scope.js'
import { findAssistantById } from '../db/users.js'
import { query } from '../db/client.js'
import { resolveRetainedWorkflowSource } from '../context-scope/workflow-authority.js'
import { gateSessionRead } from '../session-read-authority.js'
import { normalizeSessionVisibility } from '../session-kind.js'
import type { PoolClient } from 'pg'

const unavailable = () => Object.assign(new Error('Browser task authority unavailable'), { code: 'profile_authority_denied' })

/** Renew the retained ceiling and source independently; neither replaces the other. */
export async function resolveBrowserTaskExecutionAuthority(task: Pick<SandboxTaskRecord, 'userId' | 'workspaceId' | 'executionAuthority' | 'sourceAuthority'>, caller?: CurrentAuthorityBoundary, transaction?: PoolClient) {
  const frozen = parseAuthoringAuthority(task.executionAuthority)
  if (!frozen || frozen.ceiling.userId !== task.userId || frozen.ceiling.workspaceId !== task.workspaceId) throw unavailable()
  const parsedSource = task.sourceAuthority == null ? null : AuthoritySourceSchema.safeParse(task.sourceAuthority)
  if (parsedSource && !parsedSource.success) throw unavailable()
  const source = parsedSource?.data
  if (!source) throw unavailable()
  const parent = frozen.workspaceDelegation
    ? await restoreWorkspaceMcpDelegation(frozen.workspaceDelegation,createDbCapabilityStore()) : undefined
  const bounded = (original: CurrentAuthorityBoundary): CurrentAuthorityBoundary => {
    if (!parent) return original
    const execution=parent.context.executionContext!
    bindWorkspaceMcpPublication(execution)
    const lease=createAuthorityLease(frozen.ceiling,async()=>{
      await execution.security.authority.assertCurrent()
      await original.assertCurrent()
      return intersectAccessCeilings(frozen.ceiling,execution.security.ceiling)
    })
    return {
      ...lease,
      async execute<T>(operation:()=>Promise<T>):Promise<T> {
        return lease.execute(async()=>{
          await assertSourceModelInputAuthority(parent.context)
          const result=await operation()
          await assertSourceModelInputAuthority(parent.context)
          return result
        })
      },
    }
  }

  if (source?.kind === 'workflow') {
    if (source.authorityUserId !== task.userId || source.workspaceId !== task.workspaceId
      || source.executingAssistantId !== frozen.assistantId) throw unavailable()
    return bounded(createAuthorityLease(frozen.ceiling, async () => {
      const current = await resolveRetainedWorkflowSource(source, transaction)
      return pinAccessCeiling(current.turnScope.access)
    }))
  }
  // A locked file connection cannot safely fall back to owner-pool resolution.
  if (transaction) throw unavailable()
  if (source?.kind === 'session') {
    if (source.authorityUserId !== task.userId || source.workspaceId !== task.workspaceId
      || source.executingAssistantId !== frozen.assistantId) throw unavailable()
    const sessionLease = createSessionAuthorityLease({
      starting: frozen.ceiling,
      session: { id: source.id, assistantId: source.assistantId, userId: source.userId,
        contextGroupId: source.contextGroupId, contextProjectId: source.contextProjectId,
        contextLockedAt: new Date(source.contextLockedAt) },
      executingAssistantId: source.executingAssistantId, userId: source.authorityUserId,
      nativeSessionCredential:source.nativeCredential,
      memberMode: source.memberMode, ignoreSessionBinding: source.ignoreSessionBinding, systemRead: source.systemRead,
    })
    return bounded(createAuthorityLease(frozen.ceiling, async () => {
      await sessionLease.assertCurrent()
      // Unlike findSessionById, this authority-only read must not refresh activity.
      const session = (await query<Parameters<typeof gateSessionRead>[1] & { contextBindingOrigin: string }>(`SELECT id, user_id AS "userId", assistant_id AS "assistantId",
        channel_type AS "channelType", visibility, mode, effective_clearance AS "effectiveClearance",
        context_compartments AS "contextCompartments", context_project_id AS "contextProjectId", context_binding_origin AS "contextBindingOrigin"
        FROM sessions WHERE id=$1`, [source.id])).rows[0]
      if (!session || session.contextBindingOrigin === 'held' || session.visibility !== normalizeSessionVisibility(source.visibility)
        || session.mode !== source.mode || session.effectiveClearance !== source.effectiveClearance
        || JSON.stringify([...(session.contextCompartments ?? [])].sort()) !== JSON.stringify([...source.contextCompartments].sort())
        || await gateSessionRead(source.authorityUserId, session)) return null
      await sessionLease.assertCurrent()
      return frozen.ceiling
    }))
  }
  return bounded(createAuthorityLease(frozen.ceiling, async () => {
    if (source?.kind === 'invocation' && !parent) {
      if (!caller?.snapshotSource || caller.snapshotSource().invocationId !== source.invocationId) return null
      await caller.assertCurrent()
    }
    const assistant = await findAssistantById(frozen.assistantId)
    if (!assistant || assistant.workspaceId !== task.workspaceId) return null
    return resolveLiveAccessCeilingSystem({
      userId: task.userId, workspaceId: task.workspaceId, assistant,
      key: { contextGroupId: frozen.ceiling.departmentRead?.contextDepartment ?? null, contextProjectId: null },
    })
  }))
}
