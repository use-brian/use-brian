import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { createGoal } from '../../db/goals.js'
import {
  captureAuthoringAuthoritySystem,
  resolveGoalAuthoritySystem,
  resolveWorkflowRunScope,
} from '../../context-scope/workflow-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const pool = getPool()
const kinds = ['workflow_manual', 'workflow_schedule', 'goal'] as const
type Kind = typeof kinds[number]

async function fixture(kind: Kind) {
  const workspaceId = randomUUID(), ownerId = randomUUID(), userId = randomUUID(), assistantId = randomUUID()
  for (const id of [ownerId, userId]) await pool.query(
    'INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query(
    "INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic lifecycle workspace',$2,false)",
    [workspaceId, ownerId])
  await pool.query(
    "INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product')", [workspaceId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments)
    VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',ARRAY['product'])`,
    [workspaceId, ownerId, userId])
  await pool.query(`INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments)
    VALUES($1,'Synthetic lifecycle assistant',$2,$3,'primary','confidential',NULL)`,
    [assistantId, ownerId, workspaceId])
  const authoringAuthority = await captureAuthoringAuthoritySystem({ workspaceId, userId, assistantId })
  const workflows = createDbWorkflowStore(), runs = createDbWorkflowRunStore()
  const workflow = await workflows.create({
    workspaceId, userId, name: 'Synthetic lifecycle workflow', authoringAuthority,
    definition: { startStepId: 'consult', steps: [{
      id: 'consult', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'Synthetic lifecycle check',
    }] },
  })
  const run = await runs.createRun({
    workspaceId, workflowId: workflow.id,
    triggeredBy: kind === 'workflow_schedule' ? null : userId,
    triggerKind: kind === 'workflow_schedule' ? 'schedule' : 'manual',
  })
  const goal = kind === 'goal' ? await createGoal({
    workspaceId, outcome: 'Complete synthetic lifecycle check', doneWhen: { kind: 'subtasks' },
    means: { workflowId: workflow.id }, createdByUserId: userId, authoringAuthority,
  }) : null
  const resolve = () => goal
    ? resolveGoalAuthoritySystem(goal)
    : resolveWorkflowRunScope({ workspaceId, userId, assistantId, run })
  const role = (value: 'member' | 'admin') => pool.query(
    'UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2',
    [workspaceId, userId, value])
  const epoch = async () => (await pool.query<{ snapshot: { workspaceRevision: string } }>(
    'SELECT public.read_application_policy_epoch($1,$2,$3) AS snapshot',
    [workspaceId, userId, assistantId])).rows[0].snapshot
  return { workspaceId, userId, assistantId, run, resolve, role, epoch }
}

describe('[COMP:api/application-lifecycle] background invocation policy boundaries', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each(kinds)('B01/B02: unchanged %s retains the actor and permits an operation', async kind => {
    const f = await fixture(kind), authority = await f.resolve()
    expect(await authority.executeWithAuthority(async () => 'synthetic permitted result'))
      .toBe('synthetic permitted result')
    if ('executionContext' in authority) {
      expect(authority.executionContext.security.access).toMatchObject({
        workspaceId: f.workspaceId, userId: f.userId, assistantId: f.assistantId,
      })
      expect(authority.executionContext.security.authority.snapshotSource?.()).toMatchObject({
        kind: 'workflow', authorityUserId: f.userId, executingAssistantId: f.assistantId, runId: f.run.id,
      })
    } else {
      expect(authority.ceiling).toMatchObject({ workspaceId: f.workspaceId, userId: f.userId })
    }
  })

  it.each(kinds)('B02: a policy gain after %s construction prevents its first effect', async kind => {
    const f = await fixture(kind), authority = await f.resolve(), before = await f.epoch()
    await f.role('admin')
    expect((await f.epoch()).workspaceRevision).not.toBe(before.workspaceRevision)
    const effect = vi.fn(async () => 'synthetic effect')
    await expect(authority.executeWithAuthority(effect)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(kinds)('B02: %s withholds a result when policy changes during an await', async kind => {
    const f = await fixture(kind), authority = await f.resolve()
    const operation = vi.fn(async () => {
      await f.role('admin')
      return 'synthetic result that must be withheld'
    })
    await expect(authority.executeWithAuthority(operation)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it.each(kinds)('B02: a rejected %s stays rejected after rights return; a fresh invocation works', async kind => {
    const f = await fixture(kind), authority = await f.resolve()
    await f.role('admin')
    await expect(authority.executeWithAuthority(async () => 'stale')).rejects.toMatchObject({ reason: 'authority_changed' })
    await f.role('member')
    await expect(authority.executeWithAuthority(async () => 'still stale')).rejects.toMatchObject({ reason: 'authority_changed' })
    const fresh = await f.resolve()
    expect(await fresh.executeWithAuthority(async () => 'fresh authorized result')).toBe('fresh authorized result')
  })
})
