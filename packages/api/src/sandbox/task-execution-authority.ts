import { AuthoritySourceSchema, pinAccessCeiling, parseAuthoringAuthority, type CurrentAuthorityBoundary, type SandboxTaskRecord } from '@use-brian/core'
import { createAuthorityLease, createSessionAuthorityLease } from '../context-scope/authority-lease.js'
import { resolveLiveAccessCeilingSystem } from '../context-scope/resolve-turn-scope.js'
import { findAssistantById } from '../db/users.js'
import { query } from '../db/client.js'
import { resolveRetainedWorkflowSource } from '../context-scope/workflow-authority.js'
import { gateSessionRead } from '../session-read-authority.js'
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
  if (source?.kind === 'workflow') {
    if (source.authorityUserId !== task.userId || source.workspaceId !== task.workspaceId
      || source.executingAssistantId !== frozen.assistantId) throw unavailable()
    return createAuthorityLease(frozen.ceiling, async () => {
      const current = await resolveRetainedWorkflowSource(source, transaction)
      return pinAccessCeiling(current.turnScope.access)
    })
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
      memberMode: source.memberMode, ignoreSessionBinding: source.ignoreSessionBinding, systemRead: source.systemRead,
    })
    return createAuthorityLease(frozen.ceiling, async () => {
      await sessionLease.assertCurrent()
      // Unlike findSessionById, this authority-only read must not refresh activity.
      const session = (await query<Parameters<typeof gateSessionRead>[1] & { contextBindingOrigin: string }>(`SELECT id, user_id AS "userId", assistant_id AS "assistantId",
        channel_type AS "channelType", visibility, mode, effective_clearance AS "effectiveClearance",
        context_compartments AS "contextCompartments", context_project_id AS "contextProjectId", context_binding_origin AS "contextBindingOrigin"
        FROM sessions WHERE id=$1`, [source.id])).rows[0]
      if (!session || session.contextBindingOrigin === 'held' || session.visibility !== source.visibility
        || session.mode !== source.mode || session.effectiveClearance !== source.effectiveClearance
        || JSON.stringify([...(session.contextCompartments ?? [])].sort()) !== JSON.stringify([...source.contextCompartments].sort())
        || await gateSessionRead(source.authorityUserId, session)) return null
      await sessionLease.assertCurrent()
      return frozen.ceiling
    })
  }
  return createAuthorityLease(frozen.ceiling, async () => {
    if (source?.kind === 'invocation') {
      if (!caller?.snapshotSource || caller.snapshotSource().invocationId !== source.invocationId) return null
      await caller.assertCurrent()
    }
    const assistant = await findAssistantById(frozen.assistantId)
    if (!assistant || assistant.workspaceId !== task.workspaceId) return null
    return resolveLiveAccessCeilingSystem({
      userId: task.userId, workspaceId: task.workspaceId, assistant,
      key: { contextGroupId: frozen.ceiling.departmentRead?.contextDepartment ?? null, contextProjectId: null },
    })
  })
}
