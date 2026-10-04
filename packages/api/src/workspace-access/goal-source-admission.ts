import type { PoolClient } from 'pg'
import { accessCeilingContains, pinAccessCeiling, parseAuthoringAuthority, type AuthoringAuthority, type GoalCreateParams } from '@use-brian/core'
import { getPool } from '../db/client.js'
import { currentAgentAccess, runWithAgentAccess } from '../db/agent-access-context.js'
import { buildAccessPredicate, buildCurrentMemberSourcePredicate, mutationActorAccess } from '../db/access-predicate.js'
import { resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { lockOperationalPolicy } from './operational-admission.js'
import { WorkspaceAccessError } from './policy.js'

// Server capabilities, never serialized/model JSON. A retry must capture a new
// canonical source and rerun its producer; durable consent is never renewed.
type Proof = {
  userId: string; workspaceId: string; assistantId: string; taskId: string
  snapshot: string; contextGroupId: string | null; contextProjectId: string | null
  authority: AuthoringAuthority
}
const proofs = new WeakMap<object, Proof>()
const denied = () => new WorkspaceAccessError('goal_source_unsupported', 409)

function runtime(userId: string, workspaceId: string) {
  const access = currentAgentAccess()
  if (!access || access.userId !== userId || access.workspaceId !== workspaceId
    || access.sharedAudience || !Array.isArray(access.compartments)
    || !Array.isArray(access.mutationCompartments) || !Array.isArray(access.projectIds)
    || !Array.isArray(access.visibilityAssistantIds)) throw denied()
  mutationActorAccess(userId, workspaceId)
  return access
}

async function source(client: PoolClient, p: Pick<Proof, 'userId' | 'workspaceId' | 'assistantId' | 'taskId'>) {
  const ambient = runtime(p.userId, p.workspaceId)
  if (!ambient.visibilityAssistantIds!.includes(p.assistantId)) throw denied()
  const access = { ...ambient, userId: p.userId, workspaceId: p.workspaceId,
    assistantId: p.assistantId, assistantKind: 'standard' as const }
  const read = buildAccessPredicate(access, { alias: 't', startIdx: 3 })
  const write = buildAccessPredicate(access, { alias: 't', startIdx: read.nextIdx, operation: 'mutation' })
  const member = buildCurrentMemberSourcePredicate(p.userId, { alias: 't', startIdx: write.nextIdx, operation: 'mutation' })
  const row = (await client.query<{ snapshot: string; compartments: string[]; projectIds: string[]; sensitivity: 'public' | 'internal' | 'confidential' }>(`
    SELECT to_jsonb(t)::text AS snapshot,t.compartments,t.project_ids AS "projectIds",t.sensitivity
    FROM tasks t WHERE t.id=$1 AND t.workspace_id=$2 AND t.valid_to IS NULL
      AND t.retracted_at IS NULL AND NOT t.scope_held AND t.parent_id IS NULL
      AND t.user_id IS NULL AND t.assistant_id IS NULL
      AND ${read.sql} AND ${write.sql} AND ${member.sql} FOR SHARE OF t`,
  [p.taskId, p.workspaceId, ...read.params, ...write.params, ...member.params])).rows[0]
  // Operational goals cannot yet retain a private/assistant partition, nor
  // multiple department/project bindings. Reject rather than broaden them.
  if (!row || row.compartments.length > 1 || row.projectIds.length > 1) throw denied()
  let contextGroupId: string | null = null
  if (row.compartments.length) {
    const group = (await client.query(`SELECT id FROM workspace_groups WHERE workspace_id=$1
      AND compartment_key=$2 AND kind='team' AND status='active' FOR SHARE`, [p.workspaceId, row.compartments[0]])).rows[0]
    if (!group) throw denied()
    contextGroupId = group.id
  }
  return { ...row, contextGroupId, contextProjectId: row.projectIds[0] ?? null }
}

/** Call BEFORE the judge, inside the actual task writer's runtime context.
 * No pool checkout is retained while running the producer. */
export async function captureTaskGoalSource(input: { userId: string; workspaceId: string; assistantId: string; taskId: string }): Promise<object> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const policy = await lockOperationalPolicy(client, input.workspaceId)
    if (policy?.setupState !== 'ready') throw denied()
    const row = await source(client, input)
    const existing = (await client.query<{ proof: Proof }>('SELECT proof FROM goal_task_source_authority WHERE task_id=$1 FOR UPDATE', [input.taskId])).rows[0]?.proof
    const ambient = runtime(input.userId, input.workspaceId)
    // Pin only the canonical source requirements from the actual finite runtime.
    // This is producer inheritance, NOT attended authoring/default capture.
    const authority: AuthoringAuthority = existing?.authority ?? { version: 1, assistantId: input.assistantId,
      ceiling: { workspaceId: input.workspaceId, userId: input.userId, clearance: row.sensitivity,
        compartments: row.compartments, mutationCompartments: row.compartments,
        projectIds: row.projectIds, visibilityAssistantIds: [input.assistantId] } }
    const proof: Proof = { ...input, snapshot: row.snapshot, contextGroupId: row.contextGroupId,
      contextProjectId: row.contextProjectId, authority }
    if (existing && (existing.userId !== input.userId || existing.assistantId !== input.assistantId
      || existing.workspaceId !== input.workspaceId || existing.snapshot !== row.snapshot
      || existing.contextGroupId !== row.contextGroupId || existing.contextProjectId !== row.contextProjectId)) throw denied()
    if (!parseAuthoringAuthority(authority) || !accessCeilingContains(pinAccessCeiling({ ...ambient,
      userId: input.userId, workspaceId: input.workspaceId, assistantId: input.assistantId, assistantKind: 'standard' }), authority.ceiling)) throw denied()
    const scope = await resolveWorkflowAuthoringScope({ ...proof, authoringAuthority: authority }, client)
    if (!accessCeilingContains(pinAccessCeiling(scope.access), authority.ceiling)) throw denied()
    if (!existing) await client.query('INSERT INTO goal_task_source_authority(task_id,workspace_id,proof) VALUES($1,$2,$3::jsonb)', [input.taskId,input.workspaceId,JSON.stringify(proof)])
    const token = Object.freeze({})
    proofs.set(token, proof)
    await client.query('COMMIT')
    return token
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Caller holds the policy barrier until the goal INSERT commits. */
export async function admitGoalSource(client: PoolClient, params: GoalCreateParams, token: object) {
  const proof = proofs.get(token)
  if (!proof) throw denied()
  proofs.delete(token) // one attempt, including rollback/retry
  const policy = await lockOperationalPolicy(client, params.workspaceId)
  if (policy?.setupState !== 'ready' || proof.workspaceId !== params.workspaceId
    || proof.userId !== params.createdByUserId || params.host?.type !== 'task'
    || params.host.id !== proof.taskId || params.parentGoalId || params.recipeId
    || params.originSessionId || params.confirmed !== false || params.authoringAuthority != null
    || (params.contextGroupId !== undefined && params.contextGroupId !== proof.contextGroupId)
    || (params.contextProjectId !== undefined && params.contextProjectId !== proof.contextProjectId)) throw denied()
  if ((await client.query("SELECT id FROM goals WHERE workspace_id=$1 AND host_type='task' AND host_id=$2 LIMIT 1", [proof.workspaceId, proof.taskId])).rows.length) throw denied()
  const row = await source(client, proof)
  if (row.snapshot !== proof.snapshot || row.contextGroupId !== proof.contextGroupId
    || row.contextProjectId !== proof.contextProjectId) throw denied()
  const scope = await resolveWorkflowAuthoringScope({ ...proof, authoringAuthority: proof.authority }, client)
  if (!accessCeilingContains(pinAccessCeiling(scope.access), proof.authority.ceiling)) throw denied()
  return { ...params, contextGroupId: proof.contextGroupId, contextProjectId: proof.contextProjectId,
    authoringAuthority: proof.authority }
}

/** Only server producers can dereference a capability. Never expose to tools. */
export function taskGoalProducerInput(token: object): { title: string; attributes: Record<string, unknown> } {
  const proof = proofs.get(token)
  if (!proof) throw denied()
  const row = JSON.parse(proof.snapshot)
  return { title: row.title, attributes: row.attributes }
}

export async function bindTaskGoalSource(client: PoolClient, taskId: string, goalId: string) {
  const result = await client.query('UPDATE goal_task_source_authority SET goal_id=$2 WHERE task_id=$1 AND goal_id IS NULL RETURNING task_id', [taskId,goalId])
  if (result.rowCount !== 1) throw denied()
}

export function executeTaskGoalProducer<T>(token: object, producer: (task: ReturnType<typeof taskGoalProducerInput>) => Promise<T>): Promise<T> {
  const proof = proofs.get(token)
  if (!proof) throw denied()
  runtime(proof.userId, proof.workspaceId)
  return runWithAgentAccess(proof.authority.ceiling, () => producer(taskGoalProducerInput(token)))
}
