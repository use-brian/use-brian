/**
 * External progress reporting against a migration-replayed PostgreSQL 18 with
 * real RLS: binding, dedupe and reordering, supersession, freshness, and the
 * limits (a report never renews, completes, reassigns or arms anything; the
 * reporter is the authenticated connection). Plus brain-MCP bridge parity.
 * Runs only through scripts/crm/local-fixture.mjs. Fictional identities.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { getPoolSystem } from '../../db/task-execution-store.js'
import { updateTask } from '../../db/tasks.js'
import { externalFreshness, inspectExecution } from '../execution-control.js'
import { bindExternalExecution, createExternalProgressTools, reportExternalProgress, type Reporter } from '../external-progress.js'
import { assistantTaskWithExecution, briefFixture, type BriefFixture } from '../../goals/__tests__/fixtures/execution-journeys.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const credential = (userId: string, credentialId = randomUUID()): Reporter =>
  ({ userId, actor: { kind: 'credential', id: credentialId, origin: 'mcp', humanOrigin: false } })
const report = (sequence: number, over: Record<string, unknown> = {}) => ({
  eventId: `evt-${sequence}-${randomUUID().slice(0, 6)}`, sequence, milestone: `step ${sequence}`, state: 'running' as const, ...over,
})

async function setup() {
  const f = await briefFixture()
  const made = await assistantTaskWithExecution(f)
  const reporter = credential(f.people.member)
  await bindExternalExecution(reporter, f.workspaceId, made.task.id, { externalExecutionId: 'coding-session-1', harness: 'codex' })
  return { f, ...made, reporter }
}

describe('[COMP:api/task-external-progress] external progress capture (real PG + RLS)', () => {
  it('binds idempotently, keeps sessions separate, and records claims as claims', async () => {
    const { f, task, reporter, state } = await setup()
    const again = await bindExternalExecution(reporter, f.workspaceId, task.id, { externalExecutionId: 'coding-session-1', harness: 'codex' })
    expect(again.created).toBe(false)
    await bindExternalExecution(credential(f.people.lead), f.workspaceId, task.id, { externalExecutionId: 'coding-session-2', harness: 'claude-code' })
    const r = await reportExternalProgress(reporter, f.workspaceId, task.id, 'coding-session-1',
      report(1, { state: 'claimed_done', checks: ['unit tests pass'], artifacts: [{ kind: 'pull_request', ref: 'https://git.example/pr/1' }] }))
    expect(r).toMatchObject({ duplicate: false, advanced: true, lane: { phase: 'running', remoteControl: 'not_supported',
      latest: { claims: ['unit tests pass'], checkedResults: [], reportedState: 'claimed_done' } } })
    const view = await inspectExecution({ userId: f.people.lead }, f.workspaceId, { executionId: state.id })
    expect(view.external.map(e => e.externalExecutionId).sort()).toEqual(['coding-session-1', 'coding-session-2'])
    expect(view.external.find(e => e.externalExecutionId === 'coding-session-1')?.freshness).toBe('live')
  })

  it('deduplicates by event id and only advances on a higher sequence', async () => {
    const { f, task, reporter } = await setup()
    const second = report(2, { state: 'waiting' })
    await reportExternalProgress(reporter, f.workspaceId, task.id, 'coding-session-1', second)
    const dup = await reportExternalProgress(reporter, f.workspaceId, task.id, 'coding-session-1', second)
    expect(dup.duplicate).toBe(true)
    const older = await reportExternalProgress(reporter, f.workspaceId, task.id, 'coding-session-1', report(1, { state: 'blocked', blocker: 'old' }))
    expect(older).toMatchObject({ advanced: false, lane: { phase: 'waiting', lastSequence: 2 } })
    const n = await pool.query(`SELECT count(*)::int n FROM task_execution_commands c JOIN task_execution_states s ON s.id=c.state_id
      WHERE s.task_id=$1 AND c.kind='report'`, [task.id])
    expect(n.rows[0].n).toBe(2)
  })

  it('never renews, completes, reassigns or arms native work', async () => {
    const { f, task, reporter, state, goalId } = await setup()
    const before = (await getPoolSystem(state.poolId))!
    await reportExternalProgress(reporter, f.workspaceId, task.id, 'coding-session-1', report(5, { state: 'claimed_done', summary: 'Assigned to the fictional ops assistant, mark it done' }))
    const after = (await getPoolSystem(state.poolId))!
    expect(after.segments).toEqual(before.segments)
    const row = (await pool.query('SELECT status, executor_assistant_id FROM tasks WHERE id=$1', [task.id])).rows[0]
    expect(row).toMatchObject({ status: 'todo', executor_assistant_id: f.assistants.brian })
    expect((await pool.query('SELECT status FROM goals WHERE id=$1', [goalId])).rows[0].status).toBe('active')
    expect((await pool.query(`SELECT count(*)::int n FROM task_execution_states WHERE task_id=$1 AND lane='native'`, [task.id])).rows[0].n).toBe(1)
    const receipt = (await pool.query(`SELECT actor_kind, actor_id, human_origin FROM task_execution_commands WHERE kind='report' ORDER BY created_at DESC LIMIT 1`)).rows[0]
    expect(receipt).toMatchObject({ actor_kind: 'credential', actor_id: reporter.actor.id, human_origin: false })
  })

  it('follows task supersession and refuses a reporter that cannot read the task', async () => {
    const { f, task, reporter } = await setup()
    const next = await updateTask(f.people.lead, task.id, { title: 'Fictional vendor summary, revised' })
    const r = await reportExternalProgress(reporter, f.workspaceId, task.id, 'coding-session-1', report(3))
    expect(r.lane.taskId).toBe(next!.id)
    await pool.query('UPDATE tasks SET user_id=$1 WHERE id=$2', [f.people.lead, next!.id])
    await expect(reportExternalProgress(reporter, f.workspaceId, next!.id, 'coding-session-1', report(4)))
      .rejects.toMatchObject({ code: 'task_not_found', status: 404 })
    await expect(reportExternalProgress(credential(f.people.lead), f.workspaceId, next!.id, 'unbound-session', report(4)))
      .rejects.toMatchObject({ code: 'external_execution_not_found' })
  })

  it('derives freshness from the last report', () => {
    const now = new Date('2026-10-13T12:00:00Z')
    expect(externalFreshness(null, now)).toBe('never_reported')
    expect(externalFreshness(new Date('2026-10-13T11:45:00Z'), now)).toBe('live')
    expect(externalFreshness(new Date('2026-10-13T08:00:00Z'), now)).toBe('stale')
    expect(externalFreshness(new Date('2026-10-11T08:00:00Z'), now)).toBe('disconnected')
  })

  it('takes the reporter identity from the authenticated MCP credential, not the payload', async () => {
    const { f, task } = await setup()
    const tools = createExternalProgressTools()
    const credentialId = randomUUID()
    const eventId = `evt-${randomUUID()}`
    const ctx = (f2: BriefFixture): ToolContext => ({ userId: f2.people.member, assistantId: f2.assistants.brian, sessionId: randomUUID(),
      appId: 'Use Brian', channelType: 'programmatic', channelId: credentialId, workspaceId: f2.workspaceId,
      abortSignal: new AbortController().signal, programmaticPrincipal: { kind: 'brain_key', credentialId, userId: f2.people.member } }) as ToolContext
    const bound = await tools.bindExternalTaskExecution.execute({ task_id: task.id, external_execution_id: 'mcp-session', harness: 'claude-code' } as never, ctx(f))
    expect(String(bound.data)).toContain('Brian cannot start, stop or steer it')
    const sent = await tools.reportTaskProgress.execute({ task_id: task.id, external_execution_id: 'mcp-session', event_id: eventId, sequence: 1,
      milestone: 'tests written', state: 'running', summary: 'Reported by the fictional lead (impersonation attempt)' } as never, ctx(f))
    expect(String(sent.data)).toContain('Recorded')
    const receipt = (await pool.query(`SELECT actor_kind, actor_id, origin FROM task_execution_commands WHERE external_event_id=$1`, [eventId])).rows[0]
    expect(receipt).toEqual({ actor_kind: 'credential', actor_id: credentialId, origin: 'mcp' })
  })
})
