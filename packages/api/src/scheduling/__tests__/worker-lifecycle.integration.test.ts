import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { advanceWorkflowRun, createPollWorker, type ConsultRequest, type ScheduledJob } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createDbJobStore } from '../../db/job-store.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import { workflowsRoutes } from '../../routes/workflows.js'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { createJobExecutor } from '../executor.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const drainDispatchMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve))

async function fixture() {
  const role = (await getAppPool().query<{ rolsuper: boolean; rolbypassrls: boolean; active: boolean }>(
    "SELECT r.rolsuper,r.rolbypassrls,row_security_active('workflows'::regclass) AS active FROM pg_roles r WHERE r.rolname=current_user",
  )).rows[0]
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false, active: true })
  const workspaceId = randomUUID(), ownerId = randomUUID(), actorId = randomUUID(), assistantId = randomUUID(), groupId = randomUUID()
  const compartment = `team:${groupId}`
  for (const id of [ownerId, actorId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic scheduler workspace',$2,false)", [workspaceId, ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [workspaceId, ownerId, actorId])
  await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Synthetic team',$3,'team',$1::uuid::text,$4)", [groupId, workspaceId, ownerId, compartment])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Synthetic team',$3,'team',$4)", [workspaceId, compartment, ownerId, groupId])
  await pool.query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key,granted_by_user_id) VALUES($1,$2,$3)', [groupId, compartment, ownerId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,team_scope_mode) VALUES($1,'Synthetic scheduler assistant',$2,$3,'primary','internal','all')", [assistantId, ownerId, workspaceId])
  // Synthetic native workspace setup only. Runtime application qualification remains false.
  await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1", [workspaceId, groupId])
  const workflows = createDbWorkflowStore({ resolveAuthoringPrimary: async (workspace, client) =>
    (await client.query("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' LIMIT 1", [workspace])).rows[0]?.id ?? null,
  }), runs = createDbWorkflowRunStore(), jobs = createDbJobStore()
  const secret = randomUUID(), session = await authSessionStore.create(actorId, { deviceLabel: 'Synthetic scheduler', userAgent: null, ipAddress: null })
  const token = createTokens(actorId, secret, session!).accessToken
  const app = express()
  app.use(express.json()); app.use(requireAuth(secret))
  app.use('/api', workflowsRoutes({ workflowStore: workflows, runStore: runs, executorDeps: {} as never,
    workspaceStore: createWorkspaceStore(), jobStore: jobs, resolvePrimary: async () => assistantId,
    resolveAuthoringAuthority: (params, captureInTransaction) => captureInTransaction ? captureInTransaction() : captureAuthoringAuthoritySystem({ ...params, assistantId }),
  }))
  const create = async () => {
    const response = await request(app).post('/api/workflows').set('Authorization', `Bearer ${token}`).send({
      workspaceId, name: 'Synthetic native scheduled workflow',
      definition: { startStepId: 'collect', steps: [{ id: 'collect', type: 'assistant_call', target: { assistantId }, prompt: 'Return synthetic scheduled output' }] },
      trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' }, timezone: 'UTC' },
    })
    expect(response.status).toBe(201)
    const [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
    expect(job).toMatchObject({ requiresScheduleClaim: true, userId: actorId, assistantId, workflowId: response.body.id })
    await pool.query('UPDATE scheduled_jobs SET next_run_at=clock_timestamp() WHERE id=$1', [job.id])
    return { job, workflowId: response.body.id as string }
  }
  const consult = vi.fn(async (message: ConsultRequest) => {
    expect(message.caller.userId).toBe(actorId)
    expect(message.target.assistantId).toBe(assistantId)
    return { task: { taskId: randomUUID(), contextId: randomUUID(), status: { state: 'completed' as const, timestamp: new Date().toISOString() }, artifacts: [],
      history: [{ messageId: randomUUID(), role: 'agent' as const, parts: [{ kind: 'text' as const, text: 'Authorized synthetic scheduled output' }] }],
    } }
  })
  const execute = createJobExecutor({ jobStore: jobs, runWorkflowFromJob: async (job: ScheduledJob) => {
    // The native scheduled-trigger composition from boot: current actor read,
    // claim-bound run insertion, then the real workflow executor/scope resolver.
    const workflow = await workflows.getById(job.userId, job.workflowId!)
    if (!workflow?.enabled) return 'Workflow unavailable'
    const run = await runs.createRun({ workflowId: workflow.id, workspaceId, triggeredBy: null, triggerKind: 'schedule',
      scheduledJob: { id: job.id, claimId: job.scheduleClaimId! },
    })
    expect(run.triggeredBy).toBe(actorId)
    const result = await advanceWorkflowRun({ workflowStore: workflows, runStore: runs, resolvePrimary: async () => assistantId,
      resolveRunScope: resolveWorkflowRunScope, buildToolRegistry: async () => new Map(), consultTransport: { send: consult },
    }, run.id)
    expect(result.kind).toBe('completed')
    return 'Completed synthetic scheduled run'
  } })
  const created = await create()
  const executions: Array<Promise<string>> = []
  const executor = vi.fn((job: ScheduledJob) => { const promise = execute(job); executions.push(promise); return promise })
  const count = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM workflow_runs WHERE workspace_id=$1', [workspaceId])).rows[0].n
  const revoke = () => pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, actorId])
  const cleanup = async () => {
    await Promise.allSettled(executions)
    await pool.query('DELETE FROM scheduled_jobs WHERE assistant_id=$1', [assistantId])
    await pool.query('DELETE FROM workflow_runs WHERE workspace_id=$1', [workspaceId])
  }
  return { ...created, workspaceId, actorId, assistantId, workflows, jobs, consult, executor, executions, create, count, revoke, cleanup }
}

describe('[COMP:api/application-lifecycle] native schedule worker stop and current-authority restart', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each([false, true])('leaves a stopped claim unconsumed and rechecks the original actor on restart: revoked=%s', async revoked => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), nextClaim = deferred<void>(), finished = deferred<void>()
    let first = true
    const worker = createPollWorker({ executor: f.executor, store: { ...f.jobs,
      getDueJobs: async () => (await f.jobs.getDueJobs()).filter(job => job.id === f.job.id),
      async claimDueJob(id) {
        const claim = await f.jobs.claimDueJob!(id)
        if (first) { first = false; expect(claim?.scheduleClaimId).toBeTruthy(); entered.resolve(); await release.promise }
        else nextClaim.resolve()
        return claim
      },
      async finishScheduleClaim(...args) { const result = await f.jobs.finishScheduleClaim!(...args); finished.resolve(); return result },
    } })
    try {
      worker.start(); await entered.promise; worker.stop(); release.resolve(); await drainDispatchMicrotasks()
      expect(f.executor).not.toHaveBeenCalled()
      expect(f.consult).not.toHaveBeenCalled()
      expect(await f.count()).toBe(0)
      expect((await pool.query('SELECT schedule_claim_consumed,last_status FROM scheduled_jobs WHERE id=$1', [f.job.id])).rows[0])
        .toEqual({ schedule_claim_consumed: false, last_status: null })
      // Expire only this fixture's claim; restart uses the canonical claim predicate.
      await pool.query("UPDATE scheduled_jobs SET schedule_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.job.id])
      if (revoked) await f.revoke()
      worker.start(); await nextClaim.promise
      if (!revoked) await finished.promise
      await drainDispatchMicrotasks(); worker.stop()
      expect(f.executor).toHaveBeenCalledTimes(revoked ? 0 : 1)
      expect(f.consult).toHaveBeenCalledTimes(revoked ? 0 : 1)
      expect(await f.count()).toBe(revoked ? 0 : 1)
      const saved = await f.jobs.get(f.job.id)
      expect(saved).toMatchObject(revoked ? { enabled: true, lastStatus: null } : { enabled: false, lastStatus: 'completed', scheduleClaimId: null })
    } finally { release.resolve(); worker.stop(); await f.cleanup() }
  })

  it.each(['revoke', 'disable'] as const)('revalidates %s after a native claim returns but before run publication', async change => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>()
    const worker = createPollWorker({ executor: f.executor, store: { ...f.jobs,
      getDueJobs: async () => (await f.jobs.getDueJobs()).filter(job => job.id === f.job.id),
      async claimDueJob(id) { const job = await f.jobs.claimDueJob!(id); expect(job?.scheduleClaimId).toBeTruthy(); entered.resolve(); await release.promise; return job },
    } })
    try {
      worker.start(); await entered.promise
      if (change === 'revoke') await f.revoke()
      else await f.workflows.update(f.actorId, f.workflowId, { enabled: false })
      release.resolve(); await drainDispatchMicrotasks(); await Promise.allSettled(f.executions)
      expect(f.executor).toHaveBeenCalledTimes(1)
      expect(f.consult).not.toHaveBeenCalled()
      expect(await f.count()).toBe(0)
      expect((await f.jobs.get(f.job.id))?.lastStatus).toBeNull()
    } finally { release.resolve(); worker.stop(); await f.cleanup() }
  })

  it('persists a completed dispatched claim after stop without claiming the next due job', async () => {
    const f = await fixture(), second = await f.create(), entered = deferred<void>(), release = deferred<void>(), finished = deferred<void>()
    f.consult.mockImplementationOnce(async message => { entered.resolve(); await release.promise; return {
      task: { taskId: randomUUID(), contextId: randomUUID(), status: { state: 'completed', timestamp: new Date().toISOString() }, artifacts: [],
        history: [{ messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text: 'Authorized synthetic completed output' }] }],
      },
    } })
    const claim = vi.fn((id: string) => f.jobs.claimDueJob!(id))
    const worker = createPollWorker({ executor: f.executor, store: { ...f.jobs,
      getDueJobs: async () => { const jobs = await f.jobs.getDueJobs(); return [f.job.id, second.job.id].flatMap(id => jobs.filter(job => job.id === id)) },
      claimDueJob: claim,
      async finishScheduleClaim(...args) { const result = await f.jobs.finishScheduleClaim!(...args); finished.resolve(); return result },
    } })
    try {
      worker.start(); await entered.promise; worker.stop(); release.resolve(); await finished.promise; await drainDispatchMicrotasks()
      expect(f.executor).toHaveBeenCalledTimes(1)
      expect(claim).toHaveBeenCalledExactlyOnceWith(f.job.id)
      expect(await f.jobs.get(f.job.id)).toMatchObject({ enabled: false, lastStatus: 'completed', scheduleClaimId: null })
      expect(await f.jobs.get(second.job.id)).toMatchObject({ enabled: true, lastStatus: null, scheduleClaimId: null })
      expect(await f.count()).toBe(1)
    } finally { release.resolve(); worker.stop(); await f.cleanup() }
  })
})
