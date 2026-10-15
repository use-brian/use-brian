/** Actual configuration writers/authority/RLS, on the maintained owned PG18 fixture. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { type ScopeEvidence } from '@use-brian/core'
import { getPool, getAppPool, applyRLSGucs, queryWithRLS } from '../../db/client.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { applyRoutineProposal, inspectRoutineProposal, prepareRoutineProposal, rejectRoutineProposal, setRoutineIntakeEnabled } from '../routine-proposals.js'
import { createTask, updateTask } from '../../db/tasks.js'
import { flushWorkspaceData, WORKSPACE_FLUSH_TABLES } from '../../db/workspace-flush.js'
import { admitRoutineRun } from '../routine-intake.js'
import { createRule } from '../../db/task-admission-store.js'
import { createProjectSharedStore } from '../../db/project-shared-store.js'
import type { RoutineConfiguration } from '../../db/routine-intake-store.js'
import { requireRoutineSchema } from '../../db/routine-intake-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

import { setup, activate, sourceRun } from './routine-fixture.js'

describe('[COMP:api/routine-intake] atomic source-backed Task admission (real PG)', () => {
  it('I01/I10: Project home and source floors survive intake independently of Department membership',async()=>{
    const s=await setup()
    const config=s.configuration as RoutineConfiguration
    config.contextProjectId=s.f.projectId
    config.definition.taskIntake!.home={kind:'project',id:s.f.projectId}
    await activate(s)
    const source=await createTask(s.actor.userId,{workspaceId:s.f.workspaceId,title:'Prepare a fictional Project report',
      home:{kind:'project',id:s.f.projectId},compartments:[`team:${s.f.finance}`,`project:${s.f.projectId}`],projectIds:[s.f.projectId],visibility:{userId:null,assistantId:null}})
    const {run}=await sourceRun(s,source),result=await admitRoutineRun(run.id)
    expect(result.kind).toBe('created')
    if (result.kind!=='created') throw new Error('Project routine must create admitted tracking')
    await s.f.edge('user',s.f.people.outsider);await s.f.edge('user',s.f.people.member)
    expect((await queryWithRLS(s.f.people.outsider,'SELECT id FROM tasks WHERE id=$1',[result.task.id])).rows).toHaveLength(0)
    expect((await queryWithRLS(s.f.people.member,'SELECT id FROM tasks WHERE id=$1',[result.task.id])).rows).toHaveLength(1)
    await createProjectSharedStore().removeMember(s.f.people.lead,s.f.projectId,{kind:'user',id:s.f.people.member})
    expect((await queryWithRLS(s.f.people.member,'SELECT id FROM tasks WHERE id=$1',[result.task.id])).rows).toHaveLength(0)
  })
  it('creates one canonical root with the configured home/executor and actual event basis', async () => {
    const s = await setup()
    await activate(s)
    const { run, task: source } = await sourceRun(s)
    const result = await admitRoutineRun(run.id)
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') throw new Error('Expected actual intake')
    expect(result.task).toMatchObject({ parentId: null, executorAssistantId: s.f.assistants.brian,
      home: { kind: 'department', id: s.f.finance }, status: 'todo' })
    expect(result.receipt).toMatchObject({ taskId: result.task.id, acceptedRevision: 1, caseKey: `task:${source.id}` })
    expect(result.receipt.sourceEvidence.sources).toContainEqual(expect.objectContaining({ resourceKind: 'task', resourceId: source.id }))
    expect((await pool.query('SELECT count(*)::int n FROM task_execution_pools WHERE workspace_id=$1', [s.f.workspaceId])).rows[0].n).toBe(0)
  })

  it('tracks permitted partial inputs truthfully; stronger workspace tracking requirements still hold', async () => {
    const s = await setup()
    s.configuration.definition.taskIntake.blueprint.inputs.push({ key: 'destination', label: 'Where should the summary go?', path: 'event.destination', required: true })
    await activate(s)
    const a = await sourceRun(s)
    const result = await admitRoutineRun(a.run.id)
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') throw new Error('Expected waiting intake')
    expect(result.task.status).toBe('blocked')
    expect(result.qualification).toMatchObject({ kind: 'trackable', execution: 'waiting_for_input', missingInputs: ['destination'] })
    expect(result.receipt.basis.missingInputs).toEqual([{ key: 'destination', label: 'Where should the summary go?' }])
    expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1', [s.f.workspaceId])).rows[0].n).toBe(0)
    await createRule({ workspaceId: s.f.workspaceId, userId: s.actor.userId, effect: 'require', predicate: { lanes: ['extracted'], require: ['agent_ready'] },
      nlClause: null, reason: null, status: 'active' })
    const b = await sourceRun(s)
    expect(await admitRoutineRun(b.run.id)).toEqual({ kind: 'refused', reason: 'rule_requires' })
  })

  it('returns one receipt under concurrent/replayed signals and keeps different bound outcomes separate', async () => {
    const s = await setup()
    await activate(s)
    const a = await sourceRun(s)
    const results = await Promise.all(Array.from({ length: 6 }, () => admitRoutineRun(a.run.id)))
    expect(results.filter(r => r.kind === 'created')).toHaveLength(1)
    expect(results.filter(r => r.kind === 'replayed')).toHaveLength(5)
    const tasks = results.filter(r => r.kind === 'created' || r.kind === 'replayed').map(r => r.receipt.taskId)
    expect(new Set(tasks).size).toBe(1)
    const b = await sourceRun(s)
    const second = await admitRoutineRun(b.run.id)
    expect(second.kind).toBe('created')
    if (second.kind !== 'created') throw new Error('Different bound target must not merge')
    expect(second.task.id).not.toBe(tasks[0])
    expect((await pool.query('SELECT count(*)::int n FROM task_routine_intake_receipts WHERE workspace_id=$1', [s.f.workspaceId])).rows[0].n).toBe(2)
  })

  it('fences queued intake across disable/re-enable, while resolving an already committed receipt after disable', async () => {
    const s = await setup()
    await activate(s)
    const queued = await sourceRun(s)
    await s.store.update(s.actor.userId, s.workflow.id, { enabled: false })
    expect(await admitRoutineRun(queued.run.id)).toEqual({ kind: 'refused', reason: 'routine_intake_fenced' })
    await setRoutineIntakeEnabled(s.actor, s.workflow.id, {enabled:true,expectedRevision:1,idempotencyKey:randomUUID()})
    expect(await admitRoutineRun(queued.run.id)).toEqual({ kind: 'refused', reason: 'routine_intake_fenced' })
    const future = await sourceRun(s)
    const created = await admitRoutineRun(future.run.id)
    expect(created.kind).toBe('created')
    await s.store.update(s.actor.userId, s.workflow.id, { enabled: false })
    const replay = await admitRoutineRun(future.run.id)
    expect(replay.kind).toBe('replayed')
    if (created.kind === 'created' && replay.kind === 'replayed') expect(replay.receipt.taskId).toBe(created.task.id)
  })

  it('rolls back the canonical Task if its receipt cannot commit, then safely retries', async () => {
    const s = await setup()
    await activate(s)
    const { run } = await sourceRun(s)
    const name = `fixture_routine_failure_${randomUUID().replaceAll('-', '')}`
    // The receipt is an effect boundary: exercise a real database rejection,
    // not a mocked writer or admission decision. All identities are fabricated.
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${s.f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fixture_receipt_failure'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON task_routine_intake_receipts FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      await expect(admitRoutineRun(run.id)).rejects.toThrow('fixture_receipt_failure')
      expect((await pool.query('SELECT count(*)::int n FROM tasks WHERE workspace_id=$1 AND title=$2',
        [s.f.workspaceId, s.configuration.definition.taskIntake.blueprint.outcome])).rows[0].n).toBe(0)
      expect((await pool.query('SELECT count(*)::int n FROM task_routine_intake_receipts WHERE workspace_id=$1', [s.f.workspaceId])).rows[0].n).toBe(0)
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON task_routine_intake_receipts`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
    expect((await admitRoutineRun(run.id)).kind).toBe('created')
  })

  it('retains current deny/tombstone/duplicate rules and rejects changed source input', async () => {
    const s = await setup()
    await activate(s)
    await createRule({ workspaceId: s.f.workspaceId, userId: s.actor.userId, effect: 'deny', predicate: { lanes: ['extracted'] },
      nlClause: null, reason: null, status: 'active' })
    const { run } = await sourceRun(s)
    expect(await admitRoutineRun(run.id)).toEqual({ kind: 'refused', reason: 'rule' })
    await expect(pool.query("UPDATE workflow_runs SET input=jsonb_set(input,'{event,title}','\"Guessed work\"') WHERE id=$1", [run.id]))
      .rejects.toThrow('routine_signal_input_immutable')
  })

  it('keeps receipts on canonical supersession and enforces their source floor in native metadata consumers', async () => {
    const s = await setup()
    await activate(s)
    const { run, task: source } = await sourceRun(s)
    const made = await admitRoutineRun(run.id)
    if (made.kind !== 'created') throw new Error('Expected actual intake')
    const newer = (await updateTask(s.actor.userId, made.task.id, { title: 'Updated configured summary title' }))!
    const replay = await admitRoutineRun(run.id)
    expect(replay).toMatchObject({ kind: 'replayed', receipt: { taskId: newer.id } })
    // Reclassify the input to another private partition in the fixture.
    await pool.query('UPDATE tasks SET user_id=$2 WHERE id=$1', [source.id, s.f.people.member])
    expect((await queryWithRLS(s.actor.userId, 'SELECT id FROM tasks WHERE id=$1', [newer.id])).rows).toEqual([])
    expect((await queryWithRLS(s.actor.userId, 'SELECT id FROM task_routine_intake_receipts WHERE task_id=$1', [newer.id])).rows).toEqual([])
    const engine = await pool.connect()
    try {
      await engine.query('BEGIN'); await applyRLSGucs(engine, s.actor.userId)
      for (const id of [made.task.id, newer.id]) {
        const metadata = (await engine.query("SELECT read_scope_source($1,'task',$2) AS s", [s.f.workspaceId, id])).rows[0].s
        expect(metadata.held).toBe(true)
      }
    } finally { await engine.query('ROLLBACK'); engine.release() }
  })

  it('rechecks the chosen assistant at write and never substitutes the authoring assistant', async () => {
    const s = await setup()
    await s.f.edge('assistant', s.f.assistants.ops)
    s.configuration.definition.defaultExecutor = { kind: 'assistant', assistantId: s.f.assistants.ops }
    await activate(s)
    const { run } = await sourceRun(s)
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2', [s.f.workspaceId, s.f.assistants.ops])
    await expect(admitRoutineRun(run.id)).rejects.toThrow()
    expect((await pool.query('SELECT id FROM task_routine_intake_receipts WHERE workspace_id=$1', [s.f.workspaceId])).rows).toEqual([])
  })

  it('keeps an explicitly selected person as ordinary tracking and refuses a person outside a private input', async () => {
    const s = await setup()
    await s.f.edge('user', s.f.people.member)
    const memberId = (await pool.query('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
      [s.f.workspaceId, s.f.people.member])).rows[0].id
    // Use the native person slot, not follow-up or creator/primary fallback.
    s.configuration.definition.defaultExecutor = { kind: 'person', memberId }
    await activate(s)
    const shared = await sourceRun(s)
    const tracked = await admitRoutineRun(shared.run.id)
    expect(tracked.kind).toBe('created')
    if (tracked.kind !== 'created') throw new Error('Expected person tracking')
    expect(tracked.task).toMatchObject({ assigneeId: memberId, executorAssistantId: null })
    const privateSource = await createTask(s.actor.userId, { workspaceId: s.f.workspaceId, title: 'Fictional private input',
      home: { kind: 'department', id: s.f.finance }, compartments: [`team:${s.f.finance}`], visibility: { userId: s.actor.userId, assistantId: null } })
    const privateRun = await sourceRun(s, privateSource)
    expect(await admitRoutineRun(privateRun.run.id)).toEqual({ kind: 'refused', reason: 'routine_executor_unavailable' })
    expect((await pool.query('SELECT count(*)::int n FROM task_execution_pools WHERE workspace_id=$1', [s.f.workspaceId])).rows[0].n).toBe(0)
  })

  it('rejects a real admitted event that does not match the accepted source predicate', async () => {
    const s = await setup()
    s.configuration.trigger.event.sources[0].match.inChannels = ['completed']
    await activate(s)
    const { run } = await sourceRun(s)
    expect(await admitRoutineRun(run.id)).toEqual({ kind: 'refused', reason: 'routine_source_unmatched' })
    expect((await pool.query('SELECT id FROM task_routine_intake_receipts WHERE workspace_id=$1', [s.f.workspaceId])).rows).toEqual([])
  })
})

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
    await expect(store.update(actor.userId, workflow.id, { enabled: true })).rejects.toThrow('routine_human_apply_required')
    expect((await setRoutineIntakeEnabled(actor,workflow.id,{enabled:true,expectedRevision:1,idempotencyKey:randomUUID()})).enabled).toBe(true)
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
    await rejectRoutineProposal(actor,p.id,{expectedRevision:0,idempotencyKey:randomUUID()})
    expect((await inspectRoutineProposal(actor.userId,p.id)).status).toBe('rejected')
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
  it('I12: a missing native prerequisite fails the actual schema guard before any intake receipt can be written',async()=>{
    const s=await setup()
    await activate(s)
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER FUNCTION public.stamp_new_routine_configuration() RENAME TO routine_fixture_unavailable')
      await expect(requireRoutineSchema(client)).rejects.toMatchObject({status:409,message:'routine_schema_not_ready'})
      expect((await client.query('SELECT id FROM task_routine_intake_receipts WHERE workspace_id=$1',[s.f.workspaceId])).rows).toHaveLength(0)
    } finally {await client.query('ROLLBACK');client.release()}
    await expect(requireRoutineSchema()).resolves.toBeUndefined()
  })
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
    await setRoutineIntakeEnabled(actor,workflow.id,{enabled:true,expectedRevision:1,idempotencyKey:randomUUID()})
    expect(await generation()).toBe('2')
    expect(WORKSPACE_FLUSH_TABLES).toContain('task_routine_intake_receipts')
    await flushWorkspaceData(f.people.owner, f.workspaceId)
    expect((await pool.query('SELECT count(*)::int n FROM workflows WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM pending_approvals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })
})
