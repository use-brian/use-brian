/**
 * Execution controls against a migration-replayed PostgreSQL 18 with real RLS
 * and real shared-Project admission: who may pause/steer/continue, human-only
 * renewal, replay and stale revisions, and the Brian tool's attended-intent
 * rule. Runs only through scripts/crm/local-fixture.mjs. Fictional identities.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { getPoolSystem } from '../../db/task-execution-store.js'
import { createTask } from '../../db/tasks.js'
import { controlExecution, createTaskExecutionTools, inspectExecution, type ControlActor } from '../execution-control.js'
import { assistantTaskWithExecution, briefFixture, type BriefFixture } from '../../goals/__tests__/fixtures/execution-journeys.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const person = (userId: string, origin: ControlActor['origin'] = 'ui'): ControlActor => ({ userId, kind: 'user', id: userId, origin, human: true })
const body = (action: 'pause' | 'steer' | 'continue', expectedRevision: number, instruction?: string) =>
  ({ action, expectedRevision, interventionId: randomUUID(), instruction })

async function setup() {
  const f = await briefFixture()
  const made = await assistantTaskWithExecution(f)
  return { f, ...made }
}

const toolCtx = (f: BriefFixture, over: Partial<ToolContext>): ToolContext => ({
  userId: f.people.member, assistantId: f.assistants.brian, sessionId: randomUUID(), appId: 'Use Brian', channelType: 'web',
  channelId: 'c', workspaceId: f.workspaceId, abortSignal: new AbortController().signal, ...over,
}) as ToolContext

describe('[COMP:api/task-execution-control] guarded execution controls (real PG + RLS)', () => {
  it('lets roster members and the workspace owner (oversight) control shared Project work', async () => {
    const { f, state } = await setup()
    const afterControl = vi.fn(async () => {})
    let r = await controlExecution(person(f.people.member), f.workspaceId, state.id, body('pause', state.controlRevision), { afterControl })
    expect(r).toMatchObject({ outcome: 'applied', state: { phase: 'paused' }, renewedSegment: null })
    r = await controlExecution(person(f.people.owner), f.workspaceId, state.id, body('continue', r.state.controlRevision))
    expect(r).toMatchObject({ outcome: 'applied', state: { phase: 'ready' }, renewedSegment: 2 })
    expect(r.receipt).toMatchObject({ actorId: f.people.owner, humanOrigin: true })
    expect(afterControl).toHaveBeenCalledWith(expect.objectContaining({ id: state.id }), 'pause')
    const view = await inspectExecution(person(f.people.financeLead), f.workspaceId, { taskId: (await pool.query('SELECT task_id FROM task_execution_states WHERE id=$1', [state.id])).rows[0].task_id })
    expect(view).toMatchObject({ canControl: true, state: { id: state.id, controlRevision: r.state.controlRevision } })
  })

  it('refuses a workspace member outside the Project, a revoked member, a non-member and a quarantined scope', async () => {
    const { f, state } = await setup()
    await expect(controlExecution(person(f.people.outsider), f.workspaceId, state.id, body('pause', state.controlRevision)))
      .rejects.toMatchObject({ code: 'execution_control_denied', status: 403 })
    expect((await inspectExecution(person(f.people.outsider), f.workspaceId, { executionId: state.id })).canControl).toBe(false)

    await pool.query(`DELETE FROM project_shared_members WHERE project_id=$1 AND user_id=$2`, [f.projectId, f.people.member])
    await expect(controlExecution(person(f.people.member), f.workspaceId, state.id, body('pause', state.controlRevision)))
      .rejects.toMatchObject({ code: 'execution_control_denied' })

    const stranger = randomUUID()
    await pool.query(`INSERT INTO users(id,auth_provider_id,name) VALUES($1,$2,'Fictional stranger')`, [stranger, stranger])
    await expect(controlExecution(person(stranger), f.workspaceId, state.id, body('pause', state.controlRevision)))
      .rejects.toMatchObject({ code: 'execution_not_found', status: 404 })
    await expect(controlExecution(person(f.people.lead), randomUUID(), state.id, body('pause', state.controlRevision)))
      .rejects.toMatchObject({ code: 'execution_not_found' })

    await pool.query(`UPDATE project_shared_scopes SET status='quarantined' WHERE project_id=$1`, [f.projectId])
    await expect(controlExecution(person(f.people.lead), f.workspaceId, state.id, body('pause', state.controlRevision)))
      .rejects.toMatchObject({ code: 'execution_control_denied' })
    expect((await pool.query('SELECT count(*)::int n FROM task_execution_commands WHERE state_id=$1 AND kind<>$2', [state.id, 'enter'])).rows[0].n).toBe(0)
  })

  it('hides a private task execution from other members entirely', async () => {
    const f = await briefFixture()
    const made = await assistantTaskWithExecution(f, { withGoal: false })
    await pool.query('UPDATE tasks SET user_id=$1 WHERE id=$2', [f.people.lead, made.task.id])
    await expect(controlExecution(person(f.people.member), f.workspaceId, made.state.id, body('pause', 1)))
      .rejects.toMatchObject({ code: 'execution_not_found' })
    await expect(inspectExecution(person(f.people.owner), f.workspaceId, { executionId: made.state.id }))
      .rejects.toMatchObject({ code: 'execution_not_found' })
  })

  it('renews once per human intervention; replays, stale revisions and forged origins renew nothing', async () => {
    const { f, state } = await setup()
    const steer = body('steer', state.controlRevision, 'Prefer vendors with fictional local offices')
    const first = await controlExecution(person(f.people.member), f.workspaceId, state.id, steer)
    expect(first).toMatchObject({ outcome: 'applied', renewedSegment: 2 })
    const replay = await controlExecution(person(f.people.member), f.workspaceId, state.id, steer)
    expect(replay).toMatchObject({ outcome: 'duplicate', renewedSegment: null, receipt: { id: first.receipt.id } })
    const stale = await controlExecution(person(f.people.lead), f.workspaceId, state.id, body('continue', state.controlRevision))
    expect(stale).toMatchObject({ outcome: 'stale', renewedSegment: null })
    const forged: ControlActor = { userId: f.people.lead, kind: 'assistant', id: f.assistants.brian, origin: 'chat', human: true }
    const denied = await controlExecution(forged, f.workspaceId, state.id, body('continue', first.state.controlRevision))
    expect(denied).toMatchObject({ outcome: 'blocked', receipt: { humanOrigin: false, payload: { reason: 'human_intent_required' } } })
    expect((await getPoolSystem(state.poolId))!.segments).toHaveLength(2)
    // Steering is recorded on the targeted branch with its author.
    expect(first.state.steering).toEqual([expect.objectContaining({ instruction: 'Prefer vendors with fictional local offices', byUserId: f.people.member })])
  })

  it('steers only the selected branch and keeps a paused sibling paused', async () => {
    const { f, state } = await setup()
    const { createAllowanceTree } = await import('../../goals/allowance-tree.js')
    const tree = createAllowanceTree({ usageStore: null })
    const a = await tree.deriveChild(state.id, 'a', { taskId: null, executor: { kind: 'assistant', id: f.assistants.brian }, plan: {}, sourceRefs: [], dependencyOpen: false })
    const b = await tree.deriveChild(state.id, 'b', { taskId: null, executor: { kind: 'assistant', id: f.assistants.brian }, plan: {}, sourceRefs: [], dependencyOpen: false })
    await controlExecution(person(f.people.lead), f.workspaceId, b.state.id, body('pause', b.state.controlRevision))
    const steered = await controlExecution(person(f.people.lead), f.workspaceId, a.state.id, body('steer', a.state.controlRevision, 'Only check the fictional north region'))
    expect(steered.state).toMatchObject({ id: a.state.id, phase: 'ready' })
    const sib = await pool.query('SELECT phase, steering FROM task_execution_states WHERE id=$1', [b.state.id])
    expect(sib.rows[0]).toMatchObject({ phase: 'paused', steering: [] })
  })

  it('treats only an attended Brian turn as human intent', async () => {
    const { f, state } = await setup()
    const tools = createTaskExecutionTools()
    const unattended = await tools.controlTaskExecution.execute({ execution_id: state.id, action: 'steer', expected_revision: state.controlRevision, instruction: 'Speed up' } as never,
      toolCtx(f, { attended: false }))
    expect(unattended).toMatchObject({ isError: true })
    expect(String(unattended.data)).toContain('human_intent_required')
    const pause = await tools.controlTaskExecution.execute({ execution_id: state.id, action: 'pause', expected_revision: state.controlRevision } as never,
      toolCtx(f, { attended: false }))
    expect(String(pause.data)).toContain('pause applied')
    const rev = (await pool.query('SELECT control_revision::int r FROM task_execution_states WHERE id=$1', [state.id])).rows[0].r
    const attended = await tools.controlTaskExecution.execute({ execution_id: state.id, action: 'continue', expected_revision: rev } as never,
      toolCtx(f, { attended: true, workspaceActorUserId: f.people.member }))
    expect(String(attended.data)).toContain('renewed (segment 2)')
    const viaMcp = await tools.controlTaskExecution.execute({ execution_id: state.id, action: 'continue', expected_revision: rev + 1 } as never,
      toolCtx(f, { attended: true, workspaceActorUserId: f.people.member, programmaticPrincipal: { kind: 'brain_key', credentialId: randomUUID(), userId: f.people.member } }))
    expect(String(viaMcp.data)).toContain('human_intent_required')
    const read = await tools.getTaskExecution.execute({ execution_id: state.id } as never, toolCtx(f, {}))
    expect(String(read.data)).toMatch(/revision \d+\): ready/)
  })

  it('a task without a shared Project keeps native member authority', async () => {
    const f = await briefFixture()
    const task = await createTask(f.people.member, { workspaceId: f.workspaceId, title: 'Fictional non-Project work', executorAssistantId: f.assistants.brian })
    const made = await assistantTaskWithExecution(f, { withGoal: false })
    await pool.query('UPDATE task_execution_states SET task_id=$1 WHERE id=$2', [task.id, made.state.id])
    const r = await controlExecution(person(f.people.outsider), f.workspaceId, made.state.id, body('pause', made.state.controlRevision))
    expect(r.outcome).toBe('applied')
  })
})
