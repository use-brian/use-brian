/** Real PostgreSQL only, via scripts/project-harness/verify-postgres.mjs.
 * No ambient DB fallback, table stubs, requireAuth mocks or injected req.userId.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import type { HarnessRun } from '../../project-harness/execution-contracts.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture() // MUST precede getPool, including imported store use.
const { getPool, getAppPool } = await import('../client.js')
const { createProjectSharedStore } = await import('../project-shared-store.js')
const { createProjectHarnessStore } = await import('../project-harness-store.js')
const { createHarnessExecutionStore } = await import('../project-harness-execution-store.js')
const { createAuthSessionStore } = await import('../auth-session-store.js')
const { requireAuth } = await import('../../auth/middleware.js')
const { createTokens } = await import('../../auth/jwt.js')
const { projectHarnessRoutes } = await import('../../routes/project-harness.js')
const { buildVerificationPreview, runAutomaticVerification } = await import('../../project-harness/verification.js')
const pool = getPool(), shared = createProjectSharedStore(), harness = createProjectHarnessStore(), execution = createHarnessExecutionStore()
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)
const sessions = createAuthSessionStore()
const jwtSecret = randomUUID() + randomUUID()
const app = express()
app.use(express.json())
app.use('/api', requireAuth(jwtSecret), projectHarnessRoutes())
const cleanup: Array<{ workspaceId: string; users: string[] }> = []
const definition = { schemaVersion: 1 as const, rules: [], codeChecks: [], acceptanceScenarios: [{ key: 'visible', title: 'Visible fixture', preconditions: ['Ready'], steps: ['Observe'], criteria: [{ key: 'present', observation: 'Visible', evidence: 'Observation' }] }] }

async function fixture() {
  const workspaceId = randomUUID(), author = randomUUID(), reviewer = randomUUID(), requester = randomUUID()
  cleanup.push({ workspaceId, users: [author, reviewer, requester] })
  for (const id of [author, reviewer, requester]) await q("INSERT INTO users(id,auth_provider_id,name) VALUES($1,$2,'Synthetic harness user')", [id,id])
  await q("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Synthetic harness integration',$2)", [workspaceId,author])
  for (const [id,role] of [[author,'owner'],[reviewer,'member'],[requester,'member']]) {
    await q("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'internal')", [workspaceId,id,role])
  }
  await q('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=true WHERE id=$1', [workspaceId])
  const projectId = await shared.create(author,workspaceId,{name:'Harness',userIds:[reviewer,requester],assistantIds:[]})
  await shared.addOwner(author,projectId,reviewer) // Real governance, not forged owner rows.
  const actors = await Promise.all([author,reviewer,requester].map(async userId => {
    const session = await sessions.create(userId,{deviceLabel:'Synthetic integration',userAgent:null,ipAddress:null})
    if (!session) throw new Error('Session fixture creation failed')
    return { userId, authSessionId:session.id, token:createTokens(userId,jwtSecret,session).accessToken }
  }))
  const product = await harness.createProduct(author,workspaceId,projectId,{name:'Surface'})
  const revision = await harness.putDefinition(author,workspaceId,projectId,{scope:{kind:'product',productId:product.id},expectedRevision:0,definition})
  const approval = await execution.approve(actors[1],workspaceId,projectId,revision.id,1,'Separate human review')
  const create = (executor: 'human' | 'agent' = 'agent') => execution.createRun(actors[2],workspaceId,projectId,{
    approvalId:approval.id,scenarioKey:'visible',executor,build:{buildId:'fixture-build',deploymentId:'fixture-deployment'},
    target:{url:'https://example.com/',permittedOrigins:['https://example.com']},
    environment:{environmentId:'synthetic',locale:'en',timezone:'UTC',viewport:{width:800,height:600}},
  })
  return { workspaceId,projectId,author,reviewer,requester,actors,product,revision,approval,create,
    base:`/api/workspaces/${workspaceId}/projects/${projectId}/harness` }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

/** Bounded polling of an observed DB condition, never a guessed scheduling sleep. */
async function until(label: string, condition: () => Promise<boolean>, timeoutMs = 6000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await condition()) return
    await pause(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
type Outcome = { ok: true } | { ok: false; error: unknown }
/** Holds the exact authority row until PostgreSQL reports the worker blocked on us. */
async function blocked(
  f: Fixture, kind: 'session' | 'membership', work: () => Promise<unknown>,
  whileBlocked: (blocker: import('pg').PoolClient) => Promise<void>,
  prepare?: (blocker: import('pg').PoolClient) => Promise<void>,
): Promise<Outcome> {
  const blocker = await pool.connect()
  let pending: Promise<Outcome> | undefined, outcome: Outcome | undefined
  try {
    await blocker.query('BEGIN')
    await blocker.query("SET LOCAL idle_in_transaction_session_timeout='20s'; SET LOCAL statement_timeout='15s'")
    const pid = (await blocker.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid
    if (kind === 'session') await blocker.query('SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE',[f.actors[2].authSessionId])
    else await blocker.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[f.workspaceId,f.reviewer])
    if (prepare) await prepare(blocker)
    pending = work().then<Outcome,Outcome>(()=>({ok:true}),error=>({ok:false,error})).then(result=>{outcome=result;return result})
    await until('worker Lock wait on the fixture blocker', async()=>{
      if (outcome) throw new Error('Worker completed before reaching the required lock barrier')
      return (await q(`SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database()
        AND a.wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(a.pid))
        AND a.query LIKE '%harness_execution_action%'`,[pid])).rowCount !== 0
    })
    await whileBlocked(blocker)
    await blocker.query('COMMIT')
    return await pending
  } finally {
    await blocker.query('ROLLBACK').catch(()=>{})
    blocker.release()
    // The DB statement timeout bounds failure cleanup too. Never leak workers
    // into subsequent tests or leave a blocker alive after an assertion fails.
    if (pending) await pending
  }
}
function rejected(outcome: Outcome, code: string) {
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.error).toMatchObject({code})
}
/** Immutable expiry cannot be shortened by UPDATE. Seed a new short-lived row
 * as fixture owner, with a rebuilt server preview, then use actual store methods.
 */
async function nearExpiry(f: Fixture, template: HarnessRun): Promise<HarnessRun> {
  const id=randomUUID()
  const preview=buildVerificationPreview({runId:id,revision:f.revision,scenarioKey:'visible',build:template.preview.build,target:template.preview.target,environment:template.preview.environment})
  await q(`INSERT INTO project_harness_runs(id,workspace_id,project_id,revision_id,approval_id,requested_by,auth_session_id,executor,preview,status,started_at,expires_at)
    SELECT $1,workspace_id,project_id,revision_id,approval_id,requested_by,auth_session_id,executor,$3::jsonb,'running',clock_timestamp(),clock_timestamp()+interval '8 seconds'
    FROM project_harness_runs WHERE id=$2`,[id,template.id,JSON.stringify(preview)])
  return execution.run(f.requester,f.workspaceId,f.projectId,id)
}

afterAll(async()=>{
  try {
    await assertLocalFixture() // Destructive cleanup guarded again, not ambient.
    for (const f of cleanup.reverse()) {
      await q('DELETE FROM workspaces WHERE id=$1',[f.workspaceId])
      expect((await q('SELECT 1 FROM project_harness_runs WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
      expect((await q('SELECT 1 FROM project_harness_execution_audit WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
      await q('DELETE FROM users WHERE id=ANY($1::uuid[])',[f.users])
    }
  } finally { await getAppPool().end(); await pool.end() }
},30000)

describe('Project harness real PostgreSQL authority and concurrency',()=>{
  it('uses ordinary owner and restricted app role after full replay; verifies upgrade witness when supplied',async()=>{
    const owner=(await q('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(owner).toEqual({rolsuper:false,rolbypassrls:false})
    const appRole=(await getAppPool().query('SELECT current_user role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(appRole).toEqual({role:'app_user',rolsuper:false,rolbypassrls:false})
    for (const name of ['8335_project_harnesses.sql','8336_project_harness_verification.sql']) expect((await q('SELECT name FROM _migrations WHERE name=$1',[name])).rows).toHaveLength(1)
    const seed=process.env.BRIAN_HARNESS_UPGRADE_SEED
    if (seed) {
      expect(process.env.BRIAN_HARNESS_REPLAY_MODE).toBe('upgrade')
      const s=JSON.parse(seed) as {userId:string;workspaceId:string;projectId:string;productId:string;componentId:string;revisionIds:string[]}
      const history=await harness.history(s.userId,s.workspaceId,s.projectId,{kind:'component',productId:s.productId,componentId:s.componentId})
      expect(history.map(r=>r.id)).toEqual(s.revisionIds.slice().reverse())
      expect(history.map(r=>r.revision)).toEqual([2,1])
      expect(history.every(r=>r.definition.acceptanceScenarios[0]?.key==='upgrade')).toBe(true)
      cleanup.push({workspaceId:s.workspaceId,users:[s.userId]})
    } else expect(['fresh','develop-tip']).toContain(process.env.BRIAN_HARNESS_REPLAY_MODE)
  })
  it('runs requireAuth JWT/session middleware through the actual human routes and rejects a revoked token',async()=>{
    const f=await fixture(), run=await f.create('human')
    expect((await request(app).get(`${f.base}/tree`)).status).toBe(401)
    const self=await request(app).post(`${f.base}/revisions/${f.revision.id}/approve`).set('Authorization',`Bearer ${f.actors[0].token}`).send({expectedRevision:1,reason:'Self approval'})
    expect(self.status).toBe(403); expect(self.body.error).toBe('harness_independent_reviewer_required')
    const review=await request(app).post(`${f.base}/revisions/${f.revision.id}/approve`).set('Authorization',`Bearer ${f.actors[1].token}`).send({expectedRevision:1,reason:'JWT reviewer'})
    expect(review.status).toBe(201); expect(review.body.approval.approvedBy).toBe(f.reviewer)
    const observed=await request(app).post(`${f.base}/runs/${run.id}/evidence`).set('Authorization',`Bearer ${f.actors[2].token}`).send({criterionKey:'present',text:'Human observation'})
    expect(observed.status).toBe(201); expect(observed.body.evidence.provenance).toBe('human_reported')
    await sessions.revokeForUser(f.requester,f.actors[2].authSessionId)
    expect((await request(app).get(`${f.base}/runs/${run.id}`).set('Authorization',`Bearer ${f.actors[2].token}`)).status).toBe(401)
  })
  it('allows exactly one concurrent claim and refuses replay',async()=>{
    const f=await fixture(), run=await f.create()
    const results=await Promise.allSettled([execution.claimAgent(f.requester,f.workspaceId,f.projectId,run.id),execution.claimAgent(f.requester,f.workspaceId,f.projectId,run.id)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'harness_run_conflict'}})
    expect((await q("SELECT 1 FROM project_harness_execution_audit WHERE run_id=$1 AND event='running'",[run.id])).rows).toHaveLength(1)
  })
  it('invalidates pinned approval for both new and running verification after a new head',async()=>{
    const f=await fixture(), run=await f.create()
    await execution.claimAgent(f.requester,f.workspaceId,f.projectId,run.id)
    await harness.putDefinition(f.author,f.workspaceId,f.projectId,{scope:f.revision.scope,expectedRevision:1,definition})
    await expect(f.create()).rejects.toMatchObject({code:'harness_revision_stale'})
    await expect(execution.authorizeAgent(f.requester,f.workspaceId,f.projectId,run.id)).rejects.toMatchObject({code:'harness_revision_stale'})
    await expect(execution.completeAgent(f.requester,f.workspaceId,f.projectId,run.id,runAutomaticVerification(run.preview))).rejects.toMatchObject({code:'harness_revision_stale'})
  })
  it('observes committed session revocation after a real row-lock wait',async()=>{
    const f=await fixture(), run=await f.create()
    const outcome=await blocked(f,'session',()=>execution.claimAgent(f.requester,f.workspaceId,f.projectId,run.id),async blocker=>{
      await blocker.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.actors[2].authSessionId])
    })
    rejected(outcome,'harness_human_required')
    expect((await execution.run(f.author,f.workspaceId,f.projectId,run.id)).status).toBe('pending')
  })
  it('rechecks reviewer clearance after a concurrent uncommitted membership update',async()=>{
    const f=await fixture(), run=await f.create(); await execution.claimAgent(f.requester,f.workspaceId,f.projectId,run.id)
    rejected(await blocked(f,'membership',()=>execution.authorizeAgent(f.requester,f.workspaceId,f.projectId,run.id),async()=>{},async blocker=>{
      // Update before launch: policy triggers may lock the workspace as well.
      // Do not create a test-only lock-order deadlock.
      await blocker.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.reviewer])
    }),'harness_owner_required')
  })
  it('rejects a session that expires while blocked on membership, not merely at transaction start',async()=>{
    const f=await fixture(), run=await f.create(); await execution.claimAgent(f.requester,f.workspaceId,f.projectId,run.id)
    await q("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '8 seconds' WHERE id=$1",[f.actors[2].authSessionId])
    rejected(await blocked(f,'membership',()=>execution.authorizeAgent(f.requester,f.workspaceId,f.projectId,run.id),async()=>{
      expect((await q('SELECT expires_at>clock_timestamp() live FROM auth_sessions WHERE id=$1',[f.actors[2].authSessionId])).rows[0].live).toBe(true)
      await until('session deadline',async()=>(await q('SELECT expires_at<=clock_timestamp() expired FROM auth_sessions WHERE id=$1',[f.actors[2].authSessionId])).rows[0].expired,12000)
    }),'harness_human_required')
  })
  it.each(['authorize','evidence','complete'] as const)('rejects run %s after expiry during membership lock wait',async mode=>{
    const f=await fixture(), original=await f.create(), run=await nearExpiry(f,original)
    const operation=()=>mode==='authorize'?execution.authorizeAgent(f.requester,f.workspaceId,f.projectId,run.id)
      :mode==='evidence'?execution.addAgentEvidence(f.requester,f.workspaceId,f.projectId,run.id,{criterionKey:'present',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII='})
        :execution.completeAgent(f.requester,f.workspaceId,f.projectId,run.id,runAutomaticVerification(run.preview))
    rejected(await blocked(f,'membership',operation,async()=>{
      expect((await q('SELECT expires_at>clock_timestamp() live FROM project_harness_runs WHERE id=$1',[run.id])).rows[0].live).toBe(true)
      await until('run deadline',async()=>(await q('SELECT expires_at<=clock_timestamp() expired FROM project_harness_runs WHERE id=$1',[run.id])).rows[0].expired,12000)
    }),'harness_run_conflict')
    expect((await execution.evidence(f.author,f.workspaceId,f.projectId,run.id))).toEqual([])
    expect((await execution.run(f.author,f.workspaceId,f.projectId,run.id)).status).toBe('expired')
  })
})
