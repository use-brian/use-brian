import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { workflowsRoutes } from '../../routes/workflows.js'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { authSessionStore } from '../auth-session-store.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { getPool, getAppPool, runWithAgentAccess } from '../client.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../workflow-store.js'
import { createDbGoalStore } from '../goals-store.js'
import { createGoal } from '../goals.js'
import { detectAndResolveNags } from '../../scheduling/nag-resolver.js'
import { createJobExecutor } from '../../scheduling/executor.js'
import { createDbJobStore } from '../job-store.js'
import { resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
// Legacy jobs arrive leased; pinned jobs are claimed only at dispatch time.
async function claimDueJobs(jobs: ReturnType<typeof createDbJobStore>) {
  const claimed = []
  for (const candidate of await jobs.getDueJobs()) {
    const job = candidate.requiresScheduleClaim ? await jobs.claimDueJob!(candidate.id) : candidate
    if (job) claimed.push(job)
  }
  return claimed
}
async function fixture(mode: 'simple' | 'departments' = 'simple') {
  const w = randomUUID(), owner = randomUUID(), member = randomUUID(), assistant = randomUUID()
  for (const id of [owner, member]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Session admission',$2)", [w, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [w, owner])
  async function team() {
    const id = randomUUID(), key = `team:${id}`
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Department',$3,'team',$1::uuid::text,$4)", [id, w, owner, key])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Department',$3,'team',$4)", [w, key, owner, id])
    await pool.query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key,granted_by_user_id) VALUES($1,$2,$3)', [id, key, owner])
    return { id, key }
  }
  const common = await team(), other = await team()
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,team_scope_mode) VALUES($1,'Session assistant',$2,$3,'standard','internal','all')", [assistant, owner, w])
  await pool.query("UPDATE workspace_access_policies SET access_mode=$2,setup_state='ready',default_department_id=$3 WHERE workspace_id=$1", [w, mode, common.id])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'member','assigned')", [w, member])
  if (mode === 'departments') await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [common.id, member])
  const params = { userId: member, workspaceId: w, name: 'Authored',
    definition: { startStepId: 'call', steps: [{ id: 'call', type: 'assistant_call' as const, target: { assistantId: assistant }, prompt: 'test' }] } }
  const create = (patch: Partial<Parameters<ReturnType<typeof createDbWorkflowStore>['create']>[0]> = {}, expectedPolicyRevision?: string) =>
    createDbWorkflowStore().create({ ...params, ...patch }, { authoring: { kind: 'internal-human', userId: member, assistantId: assistant, expectedPolicyRevision } })
  const revision = async () => (await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1', [w])).rows[0].revision as string
  const project = randomUUID()
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$1::uuid::text,$1::uuid::text,$3)", [project, w, owner])
  return { w, owner, member, assistant, common, other, create, revision, project, params }
}


describe('operational AUTHORING admission (real PostgreSQL)', () => {

  it('Simple omission selects common; explicit null or another destination does not', async () => {
    const f = await fixture()
    const w = await f.create()
    expect(w.contextGroupId).toBe(f.common.id)
    expect(w.authoringAuthority?.ceiling).toMatchObject({ userId: f.member, compartments: [f.common.key], mutationCompartments: [f.common.key] })
    await expect(f.create({ contextGroupId: null })).rejects.toMatchObject({ code: 'access_mode_destination_conflict' })
    await expect(f.create({ contextGroupId: f.other.id })).rejects.toThrow()
    expect((await pool.query('SELECT count(*)::int AS n FROM workflows WHERE workspace_id=$1', [f.w])).rows[0].n).toBe(1)
  })
  it('Departments requires explicit selection or an authorized assistant default', async () => {
    const f = await fixture('departments')
    await expect(f.create()).rejects.toMatchObject({ code: 'context_selection_required' })
    expect((await f.create({ contextGroupId: null })).contextGroupId).toBeNull()
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)', [f.project, f.member])
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2,default_project_id=$3 WHERE id=$1', [f.assistant, f.common.id, f.project])
    expect(await f.create()).toMatchObject({ contextGroupId: f.common.id, contextProjectId: f.project })
    expect(await f.create({ contextProjectId: null })).toMatchObject({ contextProjectId: null })
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.other.id])
    await expect(f.create()).rejects.toThrow()
  })
  it('rejects unproven generic/model, actor substitution and managed authoring', async () => {
    const f = await fixture()
    const w = await f.create()
    await expect(createDbWorkflowStore().create({ ...f.params, authoringAuthority: w.authoringAuthority! })).rejects.toMatchObject({ code: 'operational_authoring_proof_required' })
    await expect(f.create({ userId: f.owner })).rejects.toMatchObject({ code: 'operational_authoring_proof_required' })
    await expect(f.create({ managedBy: 'sync' })).rejects.toMatchObject({ code: 'operational_authoring_proof_required' })
    await expect(runWithAgentAccess({ workspaceId: f.w, userId: f.member, clearance: 'public', compartments: [], mutationCompartments: [], projectIds: [] }, () => f.create())).rejects.toThrow()
  })
  it('does not turn a read grant into mutation or replace saved consent', async () => {
    const f = await fixture('departments')
    const w = await f.create({ contextGroupId: f.common.id })
    const saved = w.authoringAuthority!
    await expect(f.create({ contextGroupId: f.common.id, authoringAuthority: { ...saved, ceiling: { ...saved.ceiling, mutationCompartments: [] } } })).rejects.toMatchObject({ reason: 'workflow_authority_unavailable' })
    await expect(f.create({ contextGroupId: f.common.id, authoringAuthority: { ...saved, ceiling: { ...saved.ceiling, userId: f.owner } } })).rejects.toThrow()
    expect((await f.create({ contextGroupId: f.common.id, authoringAuthority: saved })).authoringAuthority).toEqual(saved)
    await pool.query("UPDATE assistants SET project_scope_mode='assigned' WHERE id=$1", [f.assistant])
    await expect(f.create({ contextGroupId: f.common.id, contextProjectId: f.project })).rejects.toThrow()
  })
  it('rejects foreign/archived bindings, lost membership and private visibility expansion', async () => {
    const f = await fixture('departments'), foreign = await fixture()
    await expect(f.create({ contextGroupId: foreign.common.id })).rejects.toThrow()
    const authored = await f.create({ contextGroupId: f.common.id })
    const saved = authored.authoringAuthority!
    await expect(runWithAgentAccess({ workspaceId: f.w, userId: f.member, clearance: 'internal', compartments: [f.common.key], mutationCompartments: [f.common.key], projectIds: [], visibilityAssistantIds: [foreign.assistant] }, () =>
      f.create({ contextGroupId: f.common.id, authoringAuthority: saved }))).rejects.toThrow()
    await pool.query('UPDATE workspace_access_policies SET default_department_id=$2 WHERE workspace_id=$1', [f.w, f.other.id])
    await pool.query("UPDATE workspace_groups SET status='archived' WHERE id=$1", [f.common.id])
    await expect(f.create({ contextGroupId: f.common.id })).rejects.toThrow()
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.w, f.member])
    await expect(f.create({ contextGroupId: null })).rejects.toMatchObject({ code: 'context_not_available' })
  })
  it('rechecks policy after waiting for its transaction barrier', async () => {
    const f = await fixture(), revision = await f.revision()
    const client = await pool.connect()
    await client.query('BEGIN')
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.w])
    const pending = f.create({}, revision)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'access_policy_conflict' })
    const withoutRevision = expect(f.create()).rejects.toMatchObject({ code: 'context_selection_required' })
    try {
      await client.query("UPDATE workspace_access_policies SET access_mode='departments',revision=revision+1 WHERE workspace_id=$1", [f.w])
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    await rejected
    await withoutRevision
    expect((await pool.query('SELECT count(*)::int AS n FROM workflows WHERE workspace_id=$1', [f.w])).rows[0].n).toBe(0)
  })
  it('runs inherit old binding and snapshots across mode/default changes, including explicit legacy null', async () => {
    const f = await fixture('departments')
    const w = await f.create({ contextGroupId: f.common.id })
    const general = await f.create({ contextGroupId: null })
    const store = createDbWorkflowRunStore()
    const run = await store.createRun({ workflowId: w.id, workspaceId: f.w, triggeredBy: f.member, triggerKind: 'manual' })
    const params = { userId: f.member, workspaceId: f.w, assistantId: f.assistant, run }
    await resolveWorkflowRunScope(params)
    await store.updateRun(run.id, { status: 'running' })
    const frozen = (await pool.query('SELECT execution_authority FROM workflow_runs WHERE id=$1', [run.id])).rows[0]
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1", [f.w])
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.other.id])
    expect((await resolveWorkflowRunScope(params)).turnScope.activeGroupId).toBe(f.common.id)
    expect((await pool.query('SELECT execution_authority FROM workflow_runs WHERE id=$1', [run.id])).rows[0]).toEqual(frozen)
    const inherited = await store.createRun({ workflowId: general.id, workspaceId: f.w, triggeredBy: f.member, triggerKind: 'manual' })
    expect(inherited.contextGroupId).toBeNull()
    expect(inherited.contextCompartments).toEqual([])
    expect((await createDbWorkflowStore().getById(f.member, general.id))?.contextGroupId).toBeNull()
  })
  it('ordinary human goals use the same transactional mode admission; source drafts stay blocked', async () => {
    const f = await fixture()
    const params = { workspaceId: f.w, createdByUserId: f.member, outcome: 'Finish work', doneWhen: { kind: 'subtasks' as const } }
    const human = { userId: f.member, assistantId: f.assistant }
    const goals = createDbGoalStore(human)
    const goal = await goals.create(params)
    expect(goal.contextGroupId).toBe(f.common.id)
    expect(goal.authoringAuthority?.ceiling.compartments).toEqual([f.common.key])
    await expect(goals.create({ ...params, contextGroupId: null })).rejects.toMatchObject({ code: 'access_mode_destination_conflict' })
    await expect(createGoal({ ...params, authoringAuthority: goal.authoringAuthority! })).rejects.toMatchObject({ code: 'operational_authoring_proof_required' })
    for (const patch of [{ confirmed: false }, { parentGoalId: goal.id }, { originSessionId: randomUUID() }, { host: { type: 'task' as const, id: randomUUID() } }]) {
      await expect(goals.create({ ...params, ...patch })).rejects.toMatchObject({ code: 'operational_authoring_proof_required' })
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM goals WHERE workspace_id=$1', [f.w])).rows[0].n).toBe(1)
  })
  it('Departments goal selection/defaults and old goal authority survive mode changes without reapproval', async () => {
    const f = await fixture('departments')
    const params = { workspaceId: f.w, createdByUserId: f.member, outcome: 'Finish work', doneWhen: { kind: 'subtasks' as const } }
    const goals = createDbGoalStore({ userId: f.member, assistantId: f.assistant })
    await expect(goals.create(params)).rejects.toMatchObject({ code: 'context_selection_required' })
    const general = await goals.create({ ...params, contextGroupId: null })
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.common.id])
    const bound = await goals.create(params)
    expect(bound.contextGroupId).toBe(f.common.id)
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1", [f.w])
    expect(await goals.getById(f.member, general.id)).toMatchObject({ contextGroupId: null, authoringAuthority: general.authoringAuthority })
    expect(await goals.getById(f.member, bound.id)).toMatchObject({ contextGroupId: f.common.id, authoringAuthority: bound.authoringAuthority })
  })
  it('blocks new ready-mode schedules without changing persisted legacy schedules', async () => {
    const f = await fixture()
    const params = { assistantId: f.assistant, userId: f.member, schedule: { type: 'once' as const, datetime: new Date().toISOString() }, timezone: 'UTC', instructions: 'test', channelType: 'web', channelId: 'test', nextRunAt: new Date() }
    await expect(createDbJobStore().create(params)).rejects.toMatchObject({ code: 'operational_authoring_proof_required' })
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.w])
    const job = await createDbJobStore().create(params)
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [f.w])
    expect((await pool.query('SELECT context_group_id FROM scheduled_jobs WHERE id=$1', [job.id])).rows[0].context_group_id).toBeNull()
    await expect(createDbJobStore().create({ ...params, workflowId: (await f.create()).id })).rejects.toMatchObject({ code: 'workflow_schedule_authority_unavailable' })
  })
})

/** Real JWT verification, revocable session ledger, route, and canonical insert. */
async function restFixture(mode: 'simple' | 'departments' = 'simple') {
  const f = await fixture(mode)
  await pool.query("UPDATE assistants SET kind='primary' WHERE id=$1", [f.assistant])
  const secret = randomUUID()
  const session = await authSessionStore.create(f.member, { deviceLabel: 'fixture', userAgent: null, ipAddress: null })
  const token = createTokens(f.member, secret, session!).accessToken
  const legacyCapture = vi.fn((params: Parameters<typeof captureAuthoringAuthoritySystem>[0], captureInTransaction?: () => ReturnType<typeof captureAuthoringAuthoritySystem>) =>
    captureInTransaction ? captureInTransaction() : captureAuthoringAuthoritySystem(params))
  const store = createDbWorkflowStore({ resolveAuthoringPrimary: async (workspaceId, client) =>
    (await client.query("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' LIMIT 1", [workspaceId])).rows[0]?.id ?? null })
  const jobCreate = vi.fn()
  const mount = (verified: boolean) => {
    const app = express()
    app.use(express.json())
    if (verified) app.use(requireAuth(secret))
    else app.use((req, _res, next) => { req.userId = f.member; next() })
    app.use('/api', workflowsRoutes({
      workflowStore: store, runStore: createDbWorkflowRunStore(), executorDeps: {} as never,
      workspaceStore: { getRole: async (userId: string, workspaceId: string) =>
        (await pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])).rows[0]?.role ?? null } as never,
      // Activation/review is a separate precondition, covered by route unit
      // tests. This fixture tests already-ready authoring without activating.
      getContextReadiness: async () => ({ enforcementVersion: 2, readyForActivation: true, checks: [], legacyGeneral: {} } as never),
      resolveAuthoringAuthority: (params, captureInTransaction) => legacyCapture({ ...params, assistantId: f.assistant }, captureInTransaction),
      jobStore: { create: jobCreate } as never, resolvePrimary: async () => f.assistant,
    }))
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: error.message })
    })
    return app
  }
  const body = { workspaceId: f.w, name: 'REST authored', definition: f.params.definition }
  const post = (patch = {}, verified = true, bearer = token) => request(mount(verified)).post('/api/workflows').set('Authorization', `Bearer ${bearer}`).send({ ...body, ...patch })
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM workflows WHERE workspace_id=$1', [f.w])).rows[0].n
  const patch = (id: string, body: Record<string, unknown>) => request(mount(true)).patch(`/api/workflows/${id}`).set('Authorization', `Bearer ${token}`).send(body)
  return { ...f, store, post, patch, token, secret, session: session!, legacyCapture, jobCreate, count }
}

describe('authenticated workflow REST authoring (real JWT + PostgreSQL)', () => {
  it('Simple omitted binding succeeds via verified JWT and ignores request authority/provenance', async () => {
    const f = await restFixture()
    const response = await f.post({ authoringAuthority: { ceiling: { compartments: null } }, authoring: { kind: 'internal-human', userId: f.owner }, authSessionId: randomUUID() })
    expect(response.status).toBe(201)
    const row = await f.store.getById(f.member, response.body.id)
    expect(row).toMatchObject({ contextGroupId: f.common.id, contextProjectId: null })
    expect(row?.authoringAuthority?.ceiling).toMatchObject({ userId: f.member, compartments: [f.common.key], mutationCompartments: [f.common.key] })
    expect(f.legacyCapture).not.toHaveBeenCalled()
  })
  it('binds the human destination preview to the current policy revision before publishing', async () => {
    const f = await restFixture(), revision = await f.revision()
    await pool.query("UPDATE assistants SET clearance='public' WHERE id=$1", [f.assistant])
    const stale = await f.post({ contextGroupId: f.common.id, expectedPolicyRevision: revision })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ code: 'access_policy_conflict' })
    expect(await f.count()).toBe(0)
    expect((await f.post({ contextGroupId: f.common.id, expectedPolicyRevision: await f.revision() })).status).toBe(201)
    expect((await f.post({ expectedPolicyRevision: 1 })).status).toBe(400)
  })
  it('explicit null is not collapsed into omission and failures publish no row', async () => {
    const f = await restFixture()
    expect((await f.post({ contextGroupId: null })).body).toMatchObject({ code: 'access_mode_destination_conflict' })
    expect(await f.count()).toBe(0)
    expect(f.legacyCapture).not.toHaveBeenCalled()
  })
  it('Departments needs selection or the authorized primary default; explicit General remains General', async () => {
    const f = await restFixture('departments')
    expect((await f.post()).body).toMatchObject({ code: 'context_selection_required' })
    expect((await f.post({ contextGroupId: f.common.id })).status).toBe(201)
    const general = await f.post({ contextGroupId: null })
    expect(general.status).toBe(201)
    expect((await f.store.getById(f.member, general.body.id))?.contextGroupId).toBeNull()
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.common.id])
    expect((await f.post()).status).toBe(201)
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.other.id])
    expect((await f.post()).status).toBe(409)
  })
  it('userId alone, body proof, sessionless JWT and revoked sessions cannot authorize mode defaults', async () => {
    const f = await restFixture()
    expect((await f.post({ authSessionId: f.session.id }, false)).body).toMatchObject({ code: 'operational_authoring_proof_required' })
    expect((await f.post({}, true, createTokens(f.member, f.secret).accessToken)).status).toBe(409)
    await authSessionStore.revokeForUser(f.member, f.session.id)
    expect((await f.post()).status).toBe(401)
    expect(await f.count()).toBe(0)
  })
  it('event/webhook authoring is explicitly blocked before insert or job reconcile', async () => {
    const f = await restFixture()
    for (const trigger of [
      { kind: 'webhook' },
      { kind: 'event', event: { sources: [{ source: { type: 'task' } }] } },
    ]) {
      const response = await f.post({ trigger })
      expect(response.status).toBe(409)
      expect(response.body.code).toBe('workflow_source_authoring_not_ready')
    }
    expect(await f.count()).toBe(0)
    expect(f.jobCreate).not.toHaveBeenCalled()
    expect(f.legacyCapture).not.toHaveBeenCalled()
  })
  it('publishes authenticated schedule + exact inherited firing row atomically; retries never apply mode defaults', async () => {
    const f = await restFixture()
    const trigger = { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' }, timezone: 'UTC' }
    const response = await f.post({ trigger })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const jobs = createDbJobStore()
    const [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
    expect(job).toMatchObject({ userId: f.member, assistantId: f.assistant, contextGroupId: f.common.id, contextCompartments: [f.common.key] })
    expect(f.jobCreate).not.toHaveBeenCalled() // No post-commit reconciliation.
    const saved = (await pool.query('SELECT workflow_authoring_snapshot FROM scheduled_jobs WHERE id=$1', [job.id])).rows[0]
    expect(saved.workflow_authoring_snapshot.authority).toEqual((await f.store.getById(f.member, response.body.id))?.authoringAuthority)
    await expect(jobs.create({ ...job, contextGroupId: null })).rejects.toMatchObject({ code: 'workflow_schedule_binding_conflict' })
    await pool.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1", [f.w])
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.other.id])
    expect((await jobs.create(job)).id).toBe(job.id)
    expect((await pool.query('SELECT workflow_authoring_snapshot FROM scheduled_jobs WHERE id=$1', [job.id])).rows[0]).toEqual(saved)
    await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
    const claimed = (await Promise.all([claimDueJobs(jobs), claimDueJobs(jobs)])).flat().filter(row => row.id === job.id)
    expect(claimed).toHaveLength(1)
    expect(claimed[0].contextGroupId).toBe(f.common.id)
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.w, f.member])
    await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
    expect((await claimDueJobs(jobs)).some(row => row.id === job.id)).toBe(false)
    await expect(jobs.create(job)).rejects.toThrow()
    await expect(f.store.update(f.member, response.body.id, { definition: { ...f.params.definition, steps: [] } })).rejects.toThrow('workflow_schedule_reapproval_required')
    await jobs.update(job.id, { enabled: false })
    await expect(jobs.update(job.id, { enabled: true })).rejects.toThrow('workflow_schedule_reapproval_required')
  })
  it('dispatch consumes one exact claim, freezes run consent and rejects deletion/recreation and stale leases', async () => {
    const f = await restFixture()
    const response = await f.post({ trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' } } })
    expect(response.status).toBe(201)
    const jobs = createDbJobStore(), runs = createDbWorkflowRunStore()
    let [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
    const due = async () => {
      await pool.query('UPDATE scheduled_jobs SET next_run_at=now(),schedule_claim_expires_at=now() WHERE id=$1', [job.id])
      return (await claimDueJobs(jobs)).find(row => row.id === job.id)!
    }
    const params = (claim: typeof job) => ({ workflowId: response.body.id, workspaceId: f.w, triggeredBy: null,
      triggerKind: 'schedule' as const, scheduledJob: { id: claim.id, claimId: claim.scheduleClaimId! } })
    const deletedClaim = await due()
    await jobs.delete(job.id)
    job = await jobs.create(job)
    await expect(runs.createRun(params(deletedClaim))).rejects.toMatchObject({ code: 'workflow_schedule_claim_unavailable' })
    const expired = await due()
    await pool.query("UPDATE scheduled_jobs SET schedule_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id])
    await expect(runs.createRun(params(expired))).rejects.toMatchObject({ code: 'workflow_schedule_claim_unavailable' })
    const old = await due(), current = await due()
    await pool.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1", [f.w])
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.other.id])
    await expect(runs.createRun(params(old))).rejects.toMatchObject({ code: 'workflow_schedule_claim_unavailable' })
    const results = await Promise.allSettled([runs.createRun(params(current)), runs.createRun(params(current))])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    const run = (results.find(row => row.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof runs.createRun>>>).value
    const saved = (await pool.query('SELECT execution_authority,scheduled_job_snapshot FROM workflow_runs WHERE id=$1', [run.id])).rows[0]
    expect(saved.execution_authority.workflowAuthoringAuthority).toEqual(saved.scheduled_job_snapshot.authority)
    expect(run.triggeredBy).toBe(f.member)
    await jobs.delete(job.id)
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.w])
    await expect(runs.createRun({ workflowId: response.body.id, workspaceId: f.w, triggeredBy: null, triggerKind: 'schedule' })).rejects.toMatchObject({ code: 'workflow_schedule_claim_required' })
    await expect(f.store.update(f.member, response.body.id, { authoringAuthority: { ...saved.scheduled_job_snapshot.authority, ceiling: { ...saved.scheduled_job_snapshot.authority.ceiling, compartments: null } } })).rejects.toThrow('workflow_schedule_reapproval_required')
    expect((await resolveWorkflowRunScope({ userId: f.member,workspaceId: f.w,assistantId: f.assistant,run })).turnScope.activeGroupId).toBe(f.common.id)
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.w, f.member])
    await expect(resolveWorkflowRunScope({ userId: f.member,workspaceId: f.w,assistantId: f.assistant,run })).rejects.toMatchObject({ reason: 'workflow_authority_unavailable' })
  })
  it('revocation and deletion committed while dispatch waits prevent run publication', async () => {
    for (const change of ['revoke', 'delete'] as const) {
      const f = await restFixture()
      const response = await f.post({ trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' } } })
      const jobs = createDbJobStore(), runs = createDbWorkflowRunStore()
      const [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
      await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
      const claim = (await claimDueJobs(jobs)).find(row => row.id === job.id)!
      const client = await pool.connect()
      await client.query('BEGIN')
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.w])
      const pending = runs.createRun({ workflowId: response.body.id, workspaceId: f.w, triggeredBy: null, triggerKind: 'schedule', scheduledJob: { id: job.id, claimId: claim.scheduleClaimId! } })
      const rejected = expect(pending).rejects.toThrow()
      try {
        if (change === 'revoke') await client.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.w, f.member])
        else await client.query('DELETE FROM scheduled_jobs WHERE id=$1', [job.id])
        await client.query('COMMIT')
      } finally { await client.query('ROLLBACK'); client.release() }
      await rejected
      expect((await pool.query('SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_id=$1', [response.body.id])).rows[0].n).toBe(0)
    }
  })
  it('dispatch insertion failure rolls back claim consumption and leaves it retryable', async () => {
    const f = await restFixture()
    const response = await f.post({ trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' } } })
    const jobs = createDbJobStore(), runs = createDbWorkflowRunStore()
    const [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
    await expect(runs.createRun({ workflowId: response.body.id, workspaceId: f.w, triggeredBy: null, triggerKind: 'schedule' })).rejects.toMatchObject({ code: 'workflow_schedule_claim_required' })
    await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
    const claim = (await claimDueJobs(jobs)).find(row => row.id === job.id)!
    const params = { workflowId: response.body.id, workspaceId: f.w, triggeredBy: null, triggerKind: 'schedule' as const,
      scheduledJob: { id: job.id, claimId: claim.scheduleClaimId! } }
    const name = `test_dispatch_failure_${f.w.replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.w}'::uuid THEN RAISE EXCEPTION 'fixture_dispatch_failure'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON workflow_runs FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      await expect(runs.createRun(params)).rejects.toThrow('fixture_dispatch_failure')
      expect((await pool.query('SELECT schedule_claim_consumed FROM scheduled_jobs WHERE id=$1', [job.id])).rows[0].schedule_claim_consumed).toBe(false)
      expect((await pool.query('SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_id=$1', [response.body.id])).rows[0].n).toBe(0)
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON workflow_runs`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
    expect((await runs.createRun(params)).contextGroupId).toBe(f.common.id)
  })
  it('discovery does not lease later jobs; stale outcomes cannot disable or overwrite a new claim', async () => {
    const f = await restFixture(), jobs = createDbJobStore(), runs = createDbWorkflowRunStore()
    const response = await f.post({ trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' } } })
    const [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
    await pool.query('UPDATE scheduled_jobs SET next_run_at=clock_timestamp() WHERE id=$1', [job.id])
    expect((await jobs.getDueJobs()).find(row => row.id === job.id)).toMatchObject({ requiresScheduleClaim: true,scheduleClaimId: null })
    const old = (await jobs.claimDueJob!(job.id))!
    await runs.createRun({ workflowId: response.body.id,workspaceId: f.w,triggeredBy: null,triggerKind: 'schedule',scheduledJob: { id: job.id,claimId: old.scheduleClaimId! } })
    await pool.query("UPDATE scheduled_jobs SET next_run_at=clock_timestamp()-interval '11 minutes',schedule_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id])
    const current = (await jobs.claimDueJob!(job.id))!
    await runs.createRun({ workflowId: response.body.id,workspaceId: f.w,triggeredBy: null,triggerKind: 'schedule',scheduledJob: { id: job.id,claimId: current.scheduleClaimId! } })
    for (const success of [true,false]) {
      expect(await jobs.finishScheduleClaim!(job.id,old.scheduleClaimId!,{ success,nextRunAt: new Date(0),maxConsecutiveFailures: 1 })).toMatchObject({ applied: false })
    }
    expect(await jobs.get(job.id)).toMatchObject({ enabled: true,scheduleClaimId: current.scheduleClaimId,lastStatus: null })
    await jobs.markFailed(job.id,new Date(0)) // Unfenced legacy completion cannot write pinned rows.
    expect((await jobs.get(job.id))?.lastStatus).toBeNull()
    expect(await jobs.finishScheduleClaim!(job.id,current.scheduleClaimId!,{ success: true,nextRunAt: new Date(0),maxConsecutiveFailures: 1 })).toMatchObject({ applied: true,disabled: true })
    expect(await jobs.get(job.id)).toMatchObject({ enabled: false,lastStatus: 'completed',scheduleClaimId: null })
  })
  it('fences nag takeover writes and keeps five-minute cadence independently of the lease', async () => {
    const f = await restFixture()
    const response = await f.post({ trigger: { kind: 'schedule', schedule: { type: 'cron', expression: '0 9 * * *' },
      timezone: 'UTC', policy: { nagIntervalMins: 5, nagUntilKeyword: 'done' } } })
    expect(response.status).toBe(201)
    const jobs = createDbJobStore(), runs = createDbWorkflowRunStore()
    const [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
    await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
    const old = (await jobs.claimDueJob!(job.id))!
    const dispatch = vi.fn(async (claim: typeof job) => {
      await runs.createRun({ workflowId: response.body.id, workspaceId: f.w, triggeredBy: null,
        triggerKind: 'schedule', scheduledJob: { id: claim.id, claimId: claim.scheduleClaimId! } })
      return 'ok'
    })
    const executor = createJobExecutor({ jobStore: jobs, runWorkflowFromJob: dispatch })
    // Expiry without takeover must reject even if nag timing is in the future.
    await pool.query("UPDATE scheduled_jobs SET schedule_claim_expires_at=now()-interval '1 second' WHERE id=$1", [job.id])
    const expiredRow = await jobs.get(job.id)
    await expect(executor(old)).rejects.toMatchObject({ code: 'workflow_schedule_claim_unavailable' })
    expect(await jobs.get(job.id)).toEqual(expiredRow)
    const current = (await jobs.claimDueJob!(job.id))!
    await jobs.setState(job.id, { consecutiveFailures: 3 })
    // The replacement is live and UNCONSUMED: only claim identity can fence
    // the expired executor here (a consumed-only guard would be insufficient).
    const replacement = await jobs.get(job.id)
    await expect(executor(old)).rejects.toMatchObject({ code: 'workflow_schedule_claim_unavailable' })
    expect(await jobs.get(job.id)).toEqual(replacement)
    expect(dispatch).not.toHaveBeenCalled()
    const before = Date.now()
    await executor(current)
    const active = (await jobs.get(job.id))!
    expect(active.state).toMatchObject({ consecutiveFailures: 3, activeNag: { cycleDate: expect.any(String) } })
    expect(active.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 300_000)
    expect(active.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000)
    const lease = (await pool.query('SELECT schedule_claim_expires_at FROM scheduled_jobs WHERE id=$1', [job.id])).rows[0].schedule_claim_expires_at
    expect(lease.getTime()).toBeGreaterThan(active.nextRunAt.getTime())
    await expect(executor(old)).rejects.toMatchObject({ code: 'workflow_schedule_claim_unavailable' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(await jobs.get(job.id)).toEqual(active)
    expect(await jobs.finishScheduleClaim!(job.id, old.scheduleClaimId!, { success: false, nextRunAt: new Date(0), maxConsecutiveFailures: 1 })).toMatchObject({ applied: false })
    // A passed reminder deadline cannot expire the separate live lease.
    await pool.query("UPDATE scheduled_jobs SET next_run_at=now()-interval '1 second' WHERE id=$1", [job.id])
    expect(await jobs.claimDueJob!(job.id)).toBeNull()
    await jobs.update(job.id, { nextRunAt: active.nextRunAt })
    const tomorrow = new Date(Date.now() + 86_400_000)
    expect(await jobs.finishScheduleClaim!(job.id, current.scheduleClaimId!, { success: true, nextRunAt: tomorrow, maxConsecutiveFailures: 10 })).toMatchObject({ applied: true, disabled: false })
    expect(await jobs.get(job.id)).toMatchObject({ nextRunAt: active.nextRunAt, state: { consecutiveFailures: 0 } })
    // Retry failures retain the active cadence too; resolution restores normal timing.
    for (const resolved of [false, true]) {
      await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
      const claim = (await jobs.claimDueJob!(job.id))!
      await executor(claim)
      const deadline = (await jobs.get(job.id))!.nextRunAt
      if (resolved) await jobs.setState(job.id, {})
      await jobs.finishScheduleClaim!(job.id, claim.scheduleClaimId!, { success: false, nextRunAt: tomorrow, maxConsecutiveFailures: 10 })
      expect((await jobs.get(job.id))!.nextRunAt).toEqual(resolved ? tomorrow : deadline)
    }
    // Run admission also uses the lease, never the mutable nag deadline.
    await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
    const live = (await jobs.claimDueJob!(job.id))!
    expect(await jobs.advanceScheduleClaimNag!(job.id, live.scheduleClaimId!, {
      openedAt: new Date().toISOString(), cycleDate: '2026-01-01',
    }, new Date(0))).toBe(true)
    expect(await jobs.claimDueJob!(job.id)).toBeNull()
    await expect(dispatch(live)).resolves.toBe('ok')
  })

  async function nagResolutionFixture() {
    const f = await restFixture()
    const response = await f.post({ trigger: { kind: 'schedule', schedule: { type: 'cron', expression: '0 9 * * *' },
      timezone: 'UTC', policy: { nagIntervalMins: 5, nagUntilKeyword: 'done' } } })
    expect(response.status).toBe(201)
    const jobs = createDbJobStore(), runs = createDbWorkflowRunStore()
    const [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
    const observed = { openedAt: '2026-01-01T09:00:00.000Z', cycleDate: '2026-01-01' }
    await jobs.setState(job.id, { activeNag: observed, consecutiveFailures: 3, cycleDate: 'test-preserved' })
    await jobs.update(job.id, { nextRunAt: new Date(0) })
    const claim = (await jobs.claimDueJob!(job.id))!
    const resolve = () => detectAndResolveNags({ userId: f.member, userMessage: 'done', jobStore: jobs })
    return { ...f, jobs, runs, job, claim, observed, resolve, workflowId: response.body.id }
  }

  async function waitForNagWriters(count: number) {
    // Observe real lock contention, not sleeps or mocked query ordering.
    await expect.poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%scheduled_jobs%'`)).rows[0].n).toBe(count)
  }

  it.each(['new-cycle-first', 'resolution-first'])('resolution and a new same-day nag cannot split state from deadline (%s)', async order => {
    const f = await nagResolutionFixture()
    const blocker = await pool.connect()
    const nextNag = { ...f.observed, openedAt: '2026-01-01T09:05:00.000Z' }
    const deadline = new Date('2099-01-01T09:10:00Z')
    let advancing: Promise<boolean> | undefined
    let resolving: ReturnType<typeof f.resolve> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM scheduled_jobs WHERE id=$1 FOR UPDATE', [f.job.id])
      const advance = () => f.jobs.advanceScheduleClaimNag!(f.job.id, f.claim.scheduleClaimId!, nextNag, deadline)
      if (order === 'new-cycle-first') advancing = advance()
      else resolving = f.resolve()
      await waitForNagWriters(1)
      if (order === 'new-cycle-first') resolving = f.resolve() // observes the old committed cycle
      else advancing = advance()
      await waitForNagWriters(2)
      await blocker.query('COMMIT')
      expect(await advancing).toBe(true)
      expect(await resolving).toEqual(order === 'new-cycle-first'
        ? { resolved: 0, jobIds: [] } : { resolved: 1, jobIds: [f.job.id] })
      expect(await f.jobs.get(f.job.id)).toMatchObject({ nextRunAt: deadline,
        state: { activeNag: nextNag, consecutiveFailures: 3, cycleDate: 'test-preserved' } })
      // A reply that actually observed the new cycle may resolve it exactly once.
      expect(await f.resolve()).toEqual({ resolved: 1, jobIds: [f.job.id] })
      const resolved = (await f.jobs.get(f.job.id))!
      expect(resolved.state).toEqual({ consecutiveFailures: 3, cycleDate: 'test-preserved' })
      expect(resolved.nextRunAt.getUTCHours()).toBe(9)
      expect(resolved.nextRunAt.getUTCMinutes()).toBe(0)
      expect(await f.jobs.resolveActiveNag!(f.job.id, f.member, nextNag, new Date(0))).toBe(false)
      expect(await f.jobs.get(f.job.id)).toEqual(resolved)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await Promise.allSettled([advancing, resolving].filter(Boolean))
    }
  })

  it.each(['failure-first', 'resolution-first'])('atomic resolution preserves concurrent failure backstop (%s)', async order => {
    const f = await nagResolutionFixture()
    await f.runs.createRun({ workflowId: f.workflowId, workspaceId: f.w, triggeredBy: null, triggerKind: 'schedule',
      scheduledJob: { id: f.job.id, claimId: f.claim.scheduleClaimId! } })
    const blocker = await pool.connect()
    const nextRunAt = new Date('2099-01-01T09:00:00Z')
    const fail = () => f.jobs.finishScheduleClaim!(f.job.id, f.claim.scheduleClaimId!, {
      success: false, nextRunAt, maxConsecutiveFailures: 5,
    })
    let failing: ReturnType<typeof fail> | undefined
    let resolving: ReturnType<typeof f.resolve> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM scheduled_jobs WHERE id=$1 FOR UPDATE', [f.job.id])
      if (order === 'failure-first') failing = fail()
      else resolving = f.resolve()
      await waitForNagWriters(1)
      if (order === 'failure-first') resolving = f.resolve()
      else failing = fail()
      await waitForNagWriters(2)
      await blocker.query('COMMIT')
      expect(await failing).toMatchObject({ applied: true, failures: 4, disabled: false })
      expect(await resolving).toEqual({ resolved: 1, jobIds: [f.job.id] })
      expect((await f.jobs.get(f.job.id))!.state).toEqual({ consecutiveFailures: 4, cycleDate: 'test-preserved' })
      // The next genuine failure still reaches the backstop; resolution did
      // not masquerade as a successful execution by resetting the streak.
      await f.jobs.update(f.job.id, { nextRunAt: new Date(0) })
      const claim = (await f.jobs.claimDueJob!(f.job.id))!
      await f.runs.createRun({ workflowId: f.workflowId, workspaceId: f.w, triggeredBy: null, triggerKind: 'schedule',
        scheduledJob: { id: f.job.id, claimId: claim.scheduleClaimId! } })
      expect(await f.jobs.finishScheduleClaim!(f.job.id, claim.scheduleClaimId!, {
        success: false, nextRunAt, maxConsecutiveFailures: 5,
      })).toMatchObject({ applied: true, failures: 5, disabled: true })
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await Promise.allSettled([failing, resolving].filter(Boolean))
    }
  })

  it('workflow deletion holding its row cannot deadlock claim/dispatch by cascading into an already-held job', async () => {
    for (const dispatch of [false,true]) {
      const f = await restFixture(), jobs = createDbJobStore(), runs = createDbWorkflowRunStore()
      const response = await f.post({ trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' } } })
      const [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
      await pool.query('UPDATE scheduled_jobs SET next_run_at=clock_timestamp() WHERE id=$1',[job.id])
      const claim = dispatch ? await jobs.claimDueJob!(job.id) : null
      const deleter = await pool.connect()
      await deleter.query('BEGIN')
      await deleter.query('SELECT id FROM workflows WHERE id=$1 FOR UPDATE',[response.body.id])
      const pending = dispatch ? runs.createRun({ workflowId: response.body.id,workspaceId: f.w,triggeredBy: null,triggerKind: 'schedule',scheduledJob: { id: job.id,claimId: claim!.scheduleClaimId! } }) : jobs.claimDueJob!(job.id)
      const settled = pending.then(value => ({ value }),error => ({ error }))
      try {
        await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR SHARE OF w%'")).rows[0].n).toBeGreaterThan(0)
        await deleter.query('DELETE FROM workflows WHERE id=$1',[response.body.id])
        await deleter.query('COMMIT')
      } finally { await deleter.query('ROLLBACK');deleter.release() }
      const result = await settled
      if (dispatch) expect(result).toHaveProperty('error')
      else expect(result).toEqual({ value: null })
    }
  })
  it('ready manual-to-schedule PATCH refuses before committing trigger or renewed member consent', async () => {
    const f = await restFixture()
    for (const userId of [f.member,f.owner]) {
      const existing = await f.store.create({ ...f.params,userId },{ authoring: { kind: 'internal-human',userId,assistantId: f.assistant } })
      const response = await f.patch(existing.id,{ trigger: { kind: 'schedule',schedule: { type: 'once',datetime: '2099-01-01T00:00:00Z' } } })
      expect(response.status).toBe(409)
      expect(response.body.code).toBe('workflow_schedule_edit_not_ready')
      const after = await f.store.getById(f.member,existing.id)
      expect(after?.trigger).toEqual(existing.trigger)
      expect(after?.authoringAuthority).toEqual(existing.authoringAuthority)
      expect(await createDbJobStore().listFiringJobsForWorkflowSystem(existing.id)).toEqual([])
    }
    expect(f.jobCreate).not.toHaveBeenCalled()
  })
  it('scheduled General retains old explicit null when mode and primary defaults change', async () => {
    const f = await restFixture('departments')
    const response = await f.post({ contextGroupId: null, trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' } } })
    expect(response.status).toBe(201)
    const jobs = createDbJobStore(), [job] = await jobs.listFiringJobsForWorkflowSystem(response.body.id)
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1", [f.w])
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.common.id])
    await pool.query('UPDATE scheduled_jobs SET next_run_at=now() WHERE id=$1', [job.id])
    const claimed = (await claimDueJobs(jobs)).find(row => row.id === job.id)
    expect(claimed).toMatchObject({ contextGroupId: null, contextCompartments: [], contextProjectId: null })
  })
  it('a failing firing-row insertion rolls back the workflow publication', async () => {
    const f = await restFixture()
    const name = `test_schedule_failure_${f.w.replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${f.member}'::uuid THEN RAISE EXCEPTION 'fixture_schedule_failure'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON scheduled_jobs FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      const response = await f.post({ trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2099-01-01T00:00:00Z' } } })
      expect(response.status).toBe(500)
      expect(await f.count()).toBe(0)
      expect(f.jobCreate).not.toHaveBeenCalled()
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON scheduled_jobs`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
  })
  it('missing canonical primary fails rather than using the workspace owner or another assistant', async () => {
    const f = await restFixture()
    await pool.query("UPDATE assistants SET kind='standard' WHERE id=$1", [f.assistant])
    expect((await f.post()).body).toMatchObject({ code: 'workflow_authoring_primary_unavailable' })
    expect(await f.count()).toBe(0)
  })
  it('a policy switch while POST waits cannot publish the old default or pre-captured consent', async () => {
    const f = await restFixture()
    const client = await pool.connect()
    await client.query('BEGIN')
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.w])
    const pending = f.post().then(response => response)
    try {
      await client.query("UPDATE workspace_access_policies SET access_mode='departments',revision=revision+1 WHERE workspace_id=$1", [f.w])
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    expect((await pending).body).toMatchObject({ code: 'context_selection_required' })
    expect(await f.count()).toBe(0)
    expect(f.legacyCapture).not.toHaveBeenCalled()
  })
  it('legacy route retains null General capture once; internal saved consent is never renewed', async () => {
    const f = await restFixture()
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.w])
    const response = await f.post({}, false)
    expect(response.status).toBe(201)
    expect(f.legacyCapture).toHaveBeenCalledTimes(1)
    expect(f.legacyCapture).toHaveBeenCalledWith(expect.objectContaining({ contextGroupId: null, contextProjectId: null }), expect.any(Function))
    const row = (await f.store.getById(f.member, response.body.id))!
    expect(row.contextGroupId).toBeNull()
    const callback = vi.fn(async () => { throw new Error('must not renew') })
    const copy = await f.store.create({ ...f.params, authoringAuthority: row.authoringAuthority! }, { authoring: {
      kind: 'authenticated-workflow-rest', userId: f.member, authSessionId: f.session.id, captureLegacyAuthority: callback,
    } })
    expect(copy.authoringAuthority).toEqual(row.authoringAuthority)
    expect(callback).not.toHaveBeenCalled()
  })
})

afterAll(async () => { await getAppPool().end(); await pool.end() })
