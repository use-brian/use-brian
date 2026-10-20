import { randomUUID } from 'node:crypto'
import { ContextScopeAccumulator, pinAccessCeiling, type ExecutionIdentity, type ResourceScope, type Sensitivity } from '@use-brian/core'
import { getAppPool, getPool } from '../../../db/client.js'
import { createMemory } from '../../../db/memories.js'
import { findAssistantById } from '../../../db/users.js'
import { addSessionMessage, createWorkspaceChatSession, getSessionMessages, type Session } from '../../../db/sessions.js'
import { resolveExecutionContextSystem } from '../../../context-scope/execution-context.js'

/** Synthetic rows only, after the calling suite verifies its disposable DB marker. */
export async function persistentContextFixture(clearance: Sensitivity = 'internal') {
  const role = (await getAppPool().query<{ superuser: boolean; bypass: boolean; owns: boolean }>(
    `SELECT r.rolsuper AS superuser,r.rolbypassrls AS bypass,c.relowner=r.oid AS owns
     FROM pg_roles r JOIN pg_class c ON c.oid='memories'::regclass WHERE r.rolname=current_user`,
  )).rows[0]
  if (!role || role.superuser || role.bypass || role.owns) throw new Error('Context fixture requires a non-owner non-bypass application role')
  const pool = getPool(), workspaceId = randomUUID(), ownerId = randomUUID(), firstId = randomUUID(), secondId = randomUUID(), assistantId = randomUUID()
  for (const id of [ownerId, firstId, secondId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Persistent context fixture',$2,false)", [workspaceId, ownerId])
  for (const [id, role, clearance] of [[ownerId, 'owner', 'confidential'], [firstId, 'member', 'internal'], [secondId, 'member', 'confidential']]) {
    await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)', [workspaceId, id, role, clearance])
  }
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Context fixture assistant',$2,$3,'primary','confidential')", [assistantId, ownerId, workspaceId])
  const envelope: ResourceScope = { workspaceId, userId: null, assistantId: null, sensitivity: clearance, compartments: [], projectIds: [] }
  const session = await createWorkspaceChatSession({ assistantId, starterUserId: ownerId, workspaceId, effectiveClearance: clearance, authenticatedHuman: true })
  async function execution(userId = ownerId, currentSession: Session = session, identity?: ExecutionIdentity) {
    return (await resolveExecutionContextSystem({
      userId, workspaceId, assistant: (await findAssistantById(assistantId))!, memberMode: 'member',
      sharedAudience: true, session: currentSession, sessionAuthority: currentSession,
      identity: identity ?? { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId }, lifecycle: {
        sessionId: currentSession.id, sessionPersisted: true, channelId: currentSession.channelId,
        channelType: currentSession.channelType, abortSignal: new AbortController().signal,
      },
    })).executionContext
  }
  async function delegatedExecution(userId = ownerId) {
    const parent = await execution(userId)
    return execution(userId, session, { kind: 'delegated', actorUserId: userId,
      delegationId: 'synthetic-delegated-context', parentCeiling: pinAccessCeiling(parent.security.access) })
  }
  async function history() {
    const existing = await getSessionMessages(session.id, { excludeHeld: true })
    if (existing.length) return existing
    for (const [role, text] of [['user', 'Fictional earlier request'], ['assistant', 'Fictional earlier response'], ['user', 'Fictional current request']]) {
      await addSessionMessage({ sessionId: session.id, role, content: [{ type: 'text', text }], scope: envelope })
    }
    return getSessionMessages(session.id, { excludeHeld: true })
  }
  async function memory(summary: string, privateUserId: string | null = null, sensitivity: Sensitivity = 'internal') {
    return createMemory({ workspaceId, userId: privateUserId, assistantId, summary, sensitivity, createdByUserId: ownerId })
  }
  async function modelContext(userId = ownerId) {
    return { execution: await execution(userId), accumulator: new ContextScopeAccumulator() }
  }
  async function cleanup() {
    await pool.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ownerId, firstId, secondId]])
  }
  return { pool, workspaceId, ownerId, firstId, secondId, assistantId, session, envelope, execution, delegatedExecution, history, memory, modelContext, cleanup }
}
