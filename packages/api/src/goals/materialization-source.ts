/** Canonical Goal -> completion means / native tick inheritance.
 * No transported human flag or defaults. Tokens are server-only and single-use.
 * Spec: docs/architecture/features/goals.md -> routine assignment integration.
 * [COMP:api/routine-intake-execution]
 */
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { parseAuthoringAuthority, type AuthoringAuthority, type WorkflowDefinition, type GoalRecord, type JobStore } from '@use-brian/core'
import { GOAL_TICK_KIND, type GoalLoopState } from './driver.js'
import { getGoalByIdSystem } from '../db/goals.js'
import { getPool } from '../db/client.js'
import { resolveGoalAuthoritySystem, resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { findActiveNativeExecutionSystem } from '../db/task-execution-store.js'
import { classifySession } from '../session-kind.js'
import { readRoutineOperationCeiling } from '../db/routine-intake-store.js'

type Kind = 'completion_workflow' | 'goal_tick'
type Proof = { goalId: string; kind: Kind; snapshot: object; material: object }
const proofs = new WeakMap<object, Proof>()
const denied = () => Object.assign(new Error('goal_source_scope_unavailable'), { reason: 'goal_source_scope_unavailable' })
const snapshotSql = `SELECT jsonb_build_object('workspace',workspace_id,'actor',created_by_user_id,
  'authority',authoring_authority,'group',context_group_id,'project',context_project_id,
  'hostType',host_type,'hostId',host_id,'outcome',outcome,'means',means,'confirmed',confirmed_at,'status',status,'row',to_jsonb(goals)) AS snapshot
  FROM goals WHERE id=$1`

/** The existing one-shot tick format, derived from the saved Goal identity. */
export async function scheduleNativeGoalTick(store: JobStore, goal: GoalRecord, fireAt: Date, state: GoalLoopState): Promise<void> {
  const assistantId = goal.authoringAuthority?.assistantId
  if (!assistantId || !goal.createdByUserId) throw denied()
  const material: Parameters<JobStore['create']>[0] = { assistantId, userId: goal.createdByUserId,
    schedule: { type: 'once', datetime: fireAt.toISOString().slice(0, 19) }, timezone: 'UTC', mode: 'local',
    instructions: JSON.stringify({ kind: GOAL_TICK_KIND, goalId: goal.id, state }), channelType: 'workflow', channelId: goal.id,
    nextRunAt: fireAt, contextGroupId: goal.contextGroupId, contextProjectId: goal.contextProjectId }
  await store.create(material, { sourceGoal: await captureGoalMaterializationSource(goal.id, 'goal_tick', material) })
}

/** Called only by the native Goal producer, before a bounded store write. */
export async function captureGoalMaterializationSource(goalId: string, kind: Kind, material: object): Promise<object> {
  const goal = await getGoalByIdSystem(goalId)
  if (!goal || !goal.createdByUserId || !goal.authoringAuthority || ['done','abandoned'].includes(goal.status)
    || kind === 'goal_tick' && !goal.confirmedAt) throw denied()
  const state = goal.host?.type === 'task' ? await findActiveNativeExecutionSystem({ taskId: goal.host.id }) : null
  if (state?.phase === 'paused' || kind === 'completion_workflow' && !goal.confirmedAt && (!state || state.phase !== 'ready')) throw denied()
  await (await resolveGoalAuthoritySystem(goal)).executeWithAuthority(async () => undefined)
  const snapshot = (await getPool().query(snapshotSql, [goalId])).rows[0]?.snapshot
  if (!snapshot) throw denied()
  const token = Object.freeze({})
  proofs.set(token, { goalId, kind, snapshot, material: structuredClone(material) })
  return token
}

/** Caller holds the workspace barrier through the actual native INSERT. */
export async function admitGoalMaterializationSource(client: PoolClient, token: object, kind: Kind, material: object): Promise<{
  authority: AuthoringAuthority; contextGroupId: string | null; contextProjectId: string | null
}> {
  const proof = proofs.get(token)
  if (!proof) throw denied()
  proofs.delete(token)
  if (proof.kind !== kind || !isDeepStrictEqual(proof.material, material)) throw denied()
  const current = (await client.query(`${snapshotSql} FOR SHARE`, [proof.goalId])).rows[0]?.snapshot
  if (!current || !isDeepStrictEqual(current, proof.snapshot)) throw denied()
  const authority = parseAuthoringAuthority(current.authority)
  if (!authority || authority.ceiling.workspaceId !== current.workspace || authority.ceiling.userId !== current.actor) throw denied()
  const scope = { userId: current.actor, workspaceId: current.workspace, assistantId: authority.assistantId,
    contextGroupId: current.group, contextProjectId: current.project, authoringAuthority: authority }
  await resolveWorkflowAuthoringScope(scope, client)
  const goal = await getGoalByIdSystem(proof.goalId)
  if (!goal) throw denied()
  await (await resolveGoalAuthoritySystem(goal)).executeWithAuthority(async () => undefined)
  if (kind === 'completion_workflow') {
    const m = material as { userId: string; workspaceId: string; definition: WorkflowDefinition; trigger?: { kind: string };
      contextGroupId?: string | null; contextProjectId?: string | null; authoringAuthority?: AuthoringAuthority }
    const step = m.definition.steps[0]
    if (m.userId !== current.actor || m.workspaceId !== current.workspace || m.contextGroupId !== current.group
      || m.contextProjectId !== current.project || !isDeepStrictEqual(m.authoringAuthority, authority)
      || m.trigger?.kind !== 'manual' || m.definition.steps.length !== 1 || step.type !== 'assistant_call'
      || !('assistantId' in step.target) || step.target.assistantId !== authority.assistantId
      || step.deliver || m.definition.principal || m.definition.taskIntake) throw denied()
    const state = current.hostType === 'task' ? await findActiveNativeExecutionSystem({ taskId: current.hostId }) : null
    if (state?.phase === 'paused' || !current.confirmed && (!state || state.phase !== 'ready')) throw denied()
    const receipt = current.hostType === 'task' ? await readRoutineOperationCeiling(current.workspace, current.hostId, client) : null
    if (receipt && (!step.tools || step.tools.some(t => !receipt.actions.includes(t)))) throw denied()
  } else {
    const m = material as Record<string, unknown>
    let instructions: { kind?: string; goalId?: string }
    try { instructions = JSON.parse(String(m.instructions)) } catch { throw denied() }
    if (!current.confirmed || m.assistantId !== authority.assistantId || m.userId !== current.actor
      || classifySession({ channelType: String(m.channelType), channelId: String(m.channelId), anchorKind: null }).machine !== 'workflow'
      || m.channelId !== proof.goalId || instructions.kind !== 'goal_tick'
      || instructions.goalId !== proof.goalId || m.workflowId || m.workflowStepRunId || m.viewId
      || m.contextGroupId !== current.group || m.contextProjectId !== current.project
      || m.nagIntervalMins || m.nagUntilKeyword) throw denied()
  }
  return { authority, contextGroupId: current.group, contextProjectId: current.project }
}
