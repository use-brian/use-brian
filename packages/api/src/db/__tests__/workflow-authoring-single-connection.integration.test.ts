import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { PoolClient } from 'pg'

// client.ts snapshots this at module initialization. Exercise the real embedded
// configuration, not two independent max:1 pools or a mocked query adapter.
vi.hoisted(() => { process.env.PG_SINGLE_CONNECTION = '1' })
import { getAppPool, getPool } from '../client.js'
import { createDbJobStore } from '../job-store.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../workflow-store.js'
import { workflowsRoutes } from '../../routes/workflows.js'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { authSessionStore } from '../auth-session-store.js'
import * as authority from '../../context-scope/workflow-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await pool.end() })

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), teamId = randomUUID()
  const compartment = `team:${teamId}`
  for (const id of [owner, userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Single connection workflow',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [workspaceId, owner, userId])
  await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Team',$3,'team',$1::uuid::text,$4)", [teamId, workspaceId, owner, compartment])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Team',$3,'team',$4)", [workspaceId, compartment, owner, teamId])
  await pool.query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key,granted_by_user_id) VALUES($1,$2,$3)', [teamId, compartment, owner])
  await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [teamId, userId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,team_scope_mode) VALUES($1,'Primary',$2,$3,'primary','internal','assigned')", [assistantId, owner, workspaceId])
  await pool.query('INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)', [teamId, assistantId])
  await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [assistantId, teamId])
  const definition = { startStepId: 'call', steps: [{ id: 'call', type: 'assistant_call' as const, target: { assistantId }, prompt: 'Test' }] }
  return { workspaceId, userId, assistantId, teamId, definition }
}

describe('workflow legacy authoring with the actual single shared connection', () => {
  it('REST primary lookup, canonical capture, and insertion stay on the insertion client; explicit General does not inherit defaults', async () => {
    expect(getAppPool()).toBe(pool)
    expect(pool.options.max).toBe(1)
    const f = await fixture()
    const secret = randomUUID()
    const session = await authSessionStore.create(f.userId, { deviceLabel: 'fixture', userAgent: null, ipAddress: null })
    const token = createTokens(f.userId, secret, session!).accessToken
    let capturing = false
    let primaryClient: PoolClient | undefined
    const captureSpy = vi.spyOn(authority, 'captureAuthoringAuthoritySystem')
    const originalQuery = pool.query.bind(pool)
    // Fail deterministically rather than wait for a pool timeout if any read
    // escapes the owned transaction. The pool itself really has only one slot.
    const poolQuerySpy = vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
      if (capturing) throw new Error('legacy capture escaped to pool.query')
      return (originalQuery as (...args: unknown[]) => unknown)(...args)
    }) as typeof pool.query)
    const store = createDbWorkflowStore({ resolveAuthoringPrimary: async (workspaceId, client) => {
      primaryClient = client
      return (await client.query("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' LIMIT 1", [workspaceId])).rows[0]?.id ?? null
    } })
    const legacyResolver = vi.fn(async (_params, captureInTransaction?: () => ReturnType<typeof authority.captureAuthoringAuthoritySystem>) => {
      expect(captureInTransaction).toBeTypeOf('function')
      capturing = true
      try { return await captureInTransaction!() } finally { capturing = false }
    })
    const app = express()
    app.use(express.json(), requireAuth(secret))
    app.use('/api', workflowsRoutes({
      workflowStore: store, runStore: createDbWorkflowRunStore(), executorDeps: {} as never,
      workspaceStore: { getRole: async (userId: string, workspaceId: string) =>
        (await pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])).rows[0]?.role ?? null } as never,
      resolveAuthoringAuthority: legacyResolver,
    }))
    try {
      for (const binding of [{}, { contextGroupId: null, contextProjectId: null }]) {
        const response = await request(app).post('/api/workflows').set('Authorization', `Bearer ${token}`)
          .send({ workspaceId: f.workspaceId, name: 'Legacy General', definition: f.definition, ...binding })
        expect(response.status, JSON.stringify(response.body)).toBe(201)
        expect(primaryClient).toBeDefined()
        expect(captureSpy).toHaveBeenLastCalledWith({ userId: f.userId, workspaceId: f.workspaceId, assistantId: f.assistantId,
          contextGroupId: null, contextProjectId: null }, primaryClient)
        const row = await store.getById(f.userId, response.body.id)
        expect(row).toMatchObject({ contextGroupId: null, contextProjectId: null })
        expect(row?.authoringAuthority?.assistantId).toBe(f.assistantId)
      }
      expect(legacyResolver).toHaveBeenCalledTimes(2)
      expect(pool.totalCount).toBe(1)
      await expect.poll(() => pool.waitingCount).toBe(0)
    } finally {
      captureSpy.mockRestore()
      poolQuerySpy.mockRestore()
    }
  }, 10_000)

  it('atomically publishes and dispatches a pinned ready schedule on max:1 without pool re-entry', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1", [f.workspaceId,f.teamId])
    const store = createDbWorkflowStore({ resolveAuthoringPrimary: async (workspaceId, client) =>
      (await client.query("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' LIMIT 1", [workspaceId])).rows[0]?.id ?? null })
    const workflow = await store.create({ userId: f.userId, workspaceId: f.workspaceId, name: 'Atomic schedule', definition: f.definition,
      trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' } } }, { authoring: {
      kind: 'authenticated-workflow-rest', userId: f.userId, authSessionId: randomUUID(), captureLegacyAuthority: async () => { throw new Error('must not recapture') },
    } })
    const jobs = createDbJobStore(), runs = createDbWorkflowRunStore()
    const [job] = await jobs.listFiringJobsForWorkflowSystem(workflow.id)
    await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
    expect((await jobs.getDueJobs()).find(row => row.id === job.id)?.requiresScheduleClaim).toBe(true)
    const claim = (await jobs.claimDueJob!(job.id))!
    const run = await runs.createRun({ workflowId: workflow.id, workspaceId: f.workspaceId, triggeredBy: null, triggerKind: 'schedule',
      scheduledJob: { id: job.id, claimId: claim.scheduleClaimId! } })
    expect(run).toMatchObject({ triggeredBy: f.userId,contextGroupId: f.teamId })
    expect((await pool.query('SELECT execution_authority FROM workflow_runs WHERE id=$1', [run.id])).rows[0].execution_authority.workflowAuthoringAuthority).toEqual(workflow.authoringAuthority)
    expect(getAppPool()).toBe(pool)
    expect(pool.totalCount).toBe(1)
    await expect.poll(() => pool.waitingCount).toBe(0)
  }, 10_000)

  it('supplied legacy consent never calls the primary resolver or recaptures authority', async () => {
    const f = await fixture()
    const supplied = await authority.captureAuthoringAuthoritySystem({ ...f, contextGroupId: null, contextProjectId: null })
    const primary = vi.fn(async () => { throw new Error('must not resolve primary again') })
    const legacy = vi.fn(async () => { throw new Error('must not recapture') })
    const store = createDbWorkflowStore({ resolveAuthoringPrimary: primary })
    const row = await store.create({ userId: f.userId, workspaceId: f.workspaceId, name: 'Pinned consent', definition: f.definition,
      authoringAuthority: supplied, contextGroupId: null, contextProjectId: null }, {
      authoring: { kind: 'authenticated-workflow-rest', userId: f.userId, authSessionId: randomUUID(), captureLegacyAuthority: legacy },
    })
    expect(row.authoringAuthority).toEqual(supplied)
    expect(row.contextGroupId).toBeNull()
    expect(primary).not.toHaveBeenCalled()
    expect(legacy).not.toHaveBeenCalled()
    expect(pool.totalCount).toBe(1)
    await expect.poll(() => pool.waitingCount).toBe(0)
  }, 10_000)
})
