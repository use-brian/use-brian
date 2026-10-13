/** Actual configuration writers/authority/RLS, on the maintained owned PG18 fixture. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { WorkflowDefinition, ScopeEvidence } from '@use-brian/core'
import { getPool, getAppPool, applyRLSGucs, queryWithRLS } from '../../db/client.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { applyRoutineProposal, inspectRoutineProposal, prepareRoutineProposal } from '../routine-proposals.js'
import { briefFixture } from '../../briefs/__tests__/fixture.js'
import { createTask } from '../../db/tasks.js'
import { flushWorkspaceData, WORKSPACE_FLUSH_TABLES } from '../../db/workspace-flush.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function setup() {
  const f = await briefFixture()
  const userId = f.people.financeLead
  const authority = await captureAuthoringAuthoritySystem({ userId, workspaceId: f.workspaceId, assistantId: f.assistants.brian,
    contextGroupId: f.finance, contextProjectId: null })
  const definition: WorkflowDefinition = { startStepId: 'review', steps: [{ id: 'review', type: 'tool_call', toolName: 'getTask', arguments: {} }] }
  const store = createDbWorkflowStore()
  const workflow = await store.create({ userId, workspaceId: f.workspaceId, name: 'Fictional case summaries', definition,
    contextGroupId: f.finance, contextProjectId: null, authoringAuthority: authority },
    { authoring: { kind: 'internal-human', userId, assistantId: f.assistants.brian } })
  const session = (await authSessionStore.create(userId, { deviceLabel: 'Routine fixture', ipAddress: null, userAgent: null }))!
  const actor = { kind: 'ui' as const, userId, authSessionId: session.id }
  const configuration = {
    definition: { ...definition, defaultExecutor: { kind: 'assistant' as const, assistantId: f.assistants.brian },
      taskIntake: { version: 1 as const, blueprint: { outcome: 'Prepare a fictional case summary', description: 'Summarize the admitted case',
        completionCheck: 'Summary saved', inputs: [{ key: 'case', label: 'Which case?', path: 'event.taskId', required: true }] },
      home: { kind: 'department' as const, id: f.finance }, permittedActions: [], requiredAccounts: [] } },
    trigger: { kind: 'event' as const, event: { sources: [{ source: { type: 'task' as const }, match: { inChannels: ['created'] } }] } },
    contextGroupId: f.finance, contextProjectId: null,
  }
  const command = { configuration, expectedRevision: 0, idempotencyKey: randomUUID(), rationale: 'Human-configured case summary work' }
  return { f, store, workflow, actor, command, configuration }
}

describe('[COMP:api/routine-proposals] exact configuration and human proof (real PG)', () => {
  it('keeps legacy workflows off; an inactive exact draft becomes configured only through a live human session', async () => {
    const { f, store, workflow, actor, command } = await setup()
    expect(workflow.definition.taskIntake).toBeUndefined()
    const p = await prepareRoutineProposal(actor.userId, workflow.id, command)
    expect((await store.getById(actor.userId, workflow.id))!.definition.taskIntake).toBeUndefined()
    expect(p.status).toBe('pending')
    await expect(applyRoutineProposal({ ...actor, authSessionId: randomUUID() }, p.id,
      { expectedRevision: 0, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'routine_human_apply_required' })
    const request = { expectedRevision: 0, idempotencyKey: randomUUID() }
    expect(await applyRoutineProposal(actor, p.id, request)).toEqual({ revision: 1, replayed: false })
    expect(await applyRoutineProposal(actor, p.id, request)).toEqual({ revision: 1, replayed: true })
    expect((await store.getById(actor.userId, workflow.id))!.definition.taskIntake).toEqual(command.configuration.definition.taskIntake)
    expect((await pool.query('SELECT count(*)::int n FROM task_execution_pools WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })

  it('fences ordinary model/CRUD configuration writes, preserves layout edits and disable/re-enable', async () => {
    const { store, workflow, actor, command } = await setup()
    await expect(store.update(actor.userId, workflow.id, { definition: command.configuration.definition }))
      .rejects.toThrow('routine_human_apply_required')
    const p = await prepareRoutineProposal(actor.userId, workflow.id, command)
    await applyRoutineProposal(actor, p.id, { expectedRevision: 0, idempotencyKey: randomUUID() })
    const saved = (await store.getById(actor.userId, workflow.id))!
    await expect(store.update(actor.userId, workflow.id, { definition: { ...saved.definition,
      taskIntake: { ...saved.definition.taskIntake!, permittedActions: ['saveTask'] } } }))
      .rejects.toThrow('routine_human_apply_required')
    expect(await store.update(actor.userId, workflow.id, { definition: { ...saved.definition, layout: { review: { x: 9, y: 5 } } } })).not.toBeNull()
    expect((await store.update(actor.userId, workflow.id, { enabled: false }))!.enabled).toBe(false)
    expect((await store.update(actor.userId, workflow.id, { enabled: true }))!.enabled).toBe(true)
    expect((await pool.query('SELECT task_intake_revision FROM workflows WHERE id=$1', [workflow.id])).rows[0].task_intake_revision).toBe('1')
  })

  it('rejects stale/racing exact drafts and changed idempotency payloads', async () => {
    const { store, workflow, actor, command } = await setup()
    const p = await prepareRoutineProposal(actor.userId, workflow.id, command)
    expect((await prepareRoutineProposal(actor.userId, workflow.id, command)).id).toBe(p.id)
    await expect(prepareRoutineProposal(actor.userId, workflow.id, { ...command, rationale: 'Different request' }))
      .rejects.toMatchObject({ code: 'routine_idempotency_conflict' })
    await store.update(actor.userId, workflow.id, { definition: { ...workflow.definition,
      steps: [{ id: 'review', type: 'tool_call', toolName: 'listTasks', arguments: {} }] } })
    await expect(applyRoutineProposal(actor, p.id, { expectedRevision: 0, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'routine_revision_conflict' })
    expect((await inspectRoutineProposal(actor.userId, p.id)).status).toBe('pending')
  })

  it('refuses fabricated model/tool human proof and a revoked human session', async () => {
    const { workflow, actor, command } = await setup()
    const p = await prepareRoutineProposal(actor.userId, workflow.id, command)
    await expect(applyRoutineProposal({ kind: 'tool', userId: actor.userId, approvalId: randomUUID() }, p.id,
      { expectedRevision: 0, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'routine_human_apply_required' })
    await authSessionStore.revokeForUser(actor.userId, actor.authSessionId)
    await expect(applyRoutineProposal(actor, p.id, { expectedRevision: 0, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'routine_human_apply_required' })
  })
})

describe('[COMP:api/routine-intake] persistence, source floors and RLS (real PG)', () => {
  it('cannot manufacture engine receipts or routine approval rows through the non-bypass app role', async () => {
    const { workflow, actor, command } = await setup()
    const app = await getAppPool().connect()
    try {
      await app.query('BEGIN')
      await applyRLSGucs(app, actor.userId)
      expect((await app.query('SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0].rolbypassrls).toBe(false)
      await expect(app.query(`INSERT INTO pending_approvals(workspace_id,kind,approver_user_id,tool_name,arguments)
        VALUES($1,'workflow_refinement',$2,'routine_intake_configuration',$3::jsonb)`,
        [workflow.workspaceId, actor.userId, JSON.stringify({ operation: 'routine_intake', after: command.configuration })])).rejects.toThrow(/row-level security/)
      await app.query('ROLLBACK')
      await app.query('BEGIN')
      await applyRLSGucs(app, actor.userId)
      await expect(app.query('UPDATE workflows SET definition=$2::jsonb WHERE id=$1',
        [workflow.id, JSON.stringify(command.configuration.definition)])).rejects.toThrow('routine_human_apply_required')
    } finally { await app.query('ROLLBACK'); app.release() }
  })

  it('retains private source floors in proposals and accepted workflow readers, then removes them on revocation', async () => {
    const { f, store, workflow, actor, command } = await setup()
    const task = await createTask(actor.userId, { workspaceId: f.workspaceId, title: 'Fictional private case',
      visibility: { userId: actor.userId, assistantId: null }, home: { kind: 'department', id: f.finance } })
    const source = (await queryWithRLS<{ s: NonNullable<ScopeEvidence['sources']>[number] }>(actor.userId,
      "SELECT read_entity_derivation_source($1,'task',$2) AS s", [f.workspaceId, task.id])).rows[0].s
    const evidence: ScopeEvidence = { sensitivity: source.sensitivity, compartments: source.compartments,
      projectIds: source.projectIds, sources: [source] }
    const p = await prepareRoutineProposal(actor.userId, workflow.id, command, evidence)
    await expect(inspectRoutineProposal(f.people.owner, p.id)).rejects.toMatchObject({ code: 'routine_not_found' })
    await applyRoutineProposal(actor, p.id, { expectedRevision: 0, idempotencyKey: randomUUID() })
    expect(await store.getById(f.people.owner, workflow.id)).toBeNull()
    await pool.query('UPDATE tasks SET user_id=$2 WHERE id=$1', [task.id, f.people.member])
    expect(await store.getById(actor.userId, workflow.id)).toBeNull()
    await expect(inspectRoutineProposal(actor.userId, p.id)).rejects.toMatchObject({ code: 'routine_not_found' })
  })

  it('cannot make a manual run carry a client-fabricated routine context', async () => {
    const { workflow, actor } = await setup()
    const run = await createDbWorkflowRunStore().createRun({ workflowId: workflow.id, workspaceId: workflow.workspaceId,
      triggeredBy: actor.userId, triggerKind: 'manual', input: { human_confirmed: true, workflowId: workflow.id } })
    expect((await pool.query('SELECT routine_intake_context FROM workflow_runs WHERE id=$1', [run.id])).rows[0].routine_intake_context).toBeNull()
    await expect(pool.query('UPDATE workflow_runs SET routine_intake_context=$2::jsonb WHERE id=$1', [run.id, JSON.stringify({ revision: 1 })]))
      .rejects.toThrow('routine_run_context_immutable')
  })

  it('increments only the internal intake fence on disable/enable and participates in native flush', async () => {
    const { f, store, workflow, actor, command } = await setup()
    const p = await prepareRoutineProposal(actor.userId, workflow.id, command)
    await applyRoutineProposal(actor, p.id, { expectedRevision: 0, idempotencyKey: randomUUID() })
    const generation = async () => (await pool.query('SELECT task_intake_generation FROM workflows WHERE id=$1', [workflow.id])).rows[0].task_intake_generation
    expect(await generation()).toBe('0')
    await store.update(actor.userId, workflow.id, { enabled: false })
    expect(await generation()).toBe('1')
    await store.update(actor.userId, workflow.id, { enabled: true })
    expect(await generation()).toBe('2')
    expect(WORKSPACE_FLUSH_TABLES).toContain('task_routine_intake_receipts')
    await flushWorkspaceData(f.people.owner, f.workspaceId)
    expect((await pool.query('SELECT count(*)::int n FROM workflows WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM pending_approvals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })
})
