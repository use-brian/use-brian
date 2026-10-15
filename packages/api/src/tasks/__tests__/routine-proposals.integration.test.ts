/** Native proposal/decision/configuration services and app-role source floors. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { CONFIGURE_CAPABILITY, ContextScopeAccumulator, createTaskTools, scopeEvidenceFromRows, type ToolContext, type WorkflowDefinition } from '@use-brian/core'
import { getPool, getAppPool, queryWithRLS, applyRLSGucs } from '../../db/client.js'
import { createTask } from '../../db/tasks.js'
import { applyRoutineProposal, inspectRoutineProposal, listRoutineProposals, prepareNewRoutineProposal,
  rejectRoutineProposal } from '../routine-proposals.js'
import { setup } from './routine-fixture.js'
import { createDbTaskStore } from '../../db/tasks-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { resolveWorkflowAuthoringScope } from '../../context-scope/workflow-authority.js'
import { observeRoutineTasks } from '../routine-observations.js'
import express, { Router } from 'express'
import request from 'supertest'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { mountRoutineIntakeRoutes } from '../../routes/routine-intake.js'
import { createRoutineTools } from '../routine-tools.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { applyStagedWrite } from '../../agent-surface/staged-write.js'
import { createPersonalWebSession } from '../../db/sessions.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function proposalFixture(privateSource = false) {
  const s = await setup()
  const source = await createTask(s.actor.userId, { workspaceId:s.f.workspaceId,title:'Prepare a fictional weekly summary',
    home:{kind:'department',id:s.f.finance},compartments:[`team:${s.f.finance}`],
    visibility:{userId:privateSource?s.actor.userId:null,assistantId:null} })
  const command = { ...s.command,name:'Fictional recurring summaries',authoringAssistantId:s.f.assistants.brian }
  const evidence = scopeEvidenceFromRows([source])
  const prepare = () => prepareNewRoutineProposal(s.actor.userId,s.f.workspaceId,command,evidence)
  return { ...s,source,command,evidence,prepare }
}

describe('[COMP:api/routine-proposals] inactive native proposals and exact human decisions (real PG)', () => {
  it('I07/I11: authenticated REST uses the exact same inactive proposal and live-human apply services',async()=>{
    const s=await setup()
    const secret=randomUUID()
    const authVersion=(await pool.query('SELECT auth_version FROM users WHERE id=$1',[s.actor.userId])).rows[0].auth_version
    const token=createTokens(s.actor.userId,secret,{id:s.actor.authSessionId,authVersion}).accessToken
    const app=express(),router=Router();app.use(express.json());app.use('/api',requireAuth(secret),router);mountRoutineIntakeRoutes(router)
    const result=await request(app).post('/api/workflows/intake-proposals').auth(token,{type:'bearer'}).send({
      ...s.command,workspaceId:s.f.workspaceId,name:'Fictional report routine',authoringAssistantId:s.f.assistants.brian})
    expect(result.status).toBe(200)
    const proposal=result.body
    expect((await pool.query('SELECT id FROM workflows WHERE id=$1',[proposal.arguments.workflowId])).rows).toHaveLength(0)
    const detail=await request(app).get(`/api/workflows/intake-proposals/${proposal.id}`).auth(token,{type:'bearer'})
    expect(detail.status,JSON.stringify(detail.body)).toBe(200)
    expect(detail.body.arguments).toEqual(proposal.arguments)
    const decision={expectedRevision:0,idempotencyKey:randomUUID()}
    expect((await request(app).post(`/api/workflows/intake-proposals/${proposal.id}/apply`).auth(token,{type:'bearer'}).send(decision)).body).toEqual({revision:1,replayed:false})
    expect((await request(app).patch(`/api/workflows/${proposal.arguments.workflowId}/intake`).auth(token,{type:'bearer'}).send({enabled:false,expectedRevision:1,idempotencyKey:randomUUID()})).body.enabled).toBe(false)
    expect((await request(app).get(`/api/workflows/intake-proposals?workspaceId=${s.f.workspaceId}&workflowId=invalid`).auth(token,{type:'bearer'})).status).toBe(400)
  })

  it('I08/I10: origin Chat pickup uses the actual admitted session and preserves its personal/source floors',async()=>{
    const s=await proposalFixture()
    await s.f.edge('user',s.f.people.lead)
    const authVersion=(await pool.query('SELECT auth_version FROM users WHERE id=$1',[s.actor.userId])).rows[0].auth_version
    const session=await createPersonalWebSession({assistantId:s.f.assistants.brian,userId:s.actor.userId,workspaceId:s.f.workspaceId,
      channelType:'web',channelId:randomUUID(),appOrigin:'chat',contextGroupId:s.f.finance,contextProjectId:null},
      {actorUserId:s.actor.userId,authSessionId:s.actor.authSessionId,authVersion})
    const p=await prepareNewRoutineProposal(s.actor.userId,s.f.workspaceId,s.command,s.evidence,session.id)
    expect((await listRoutineProposals(s.actor.userId,s.f.workspaceId,undefined,session.id)).map(p=>p.id)).toEqual([p.id])
    await expect(listRoutineProposals(s.f.people.lead,s.f.workspaceId,undefined,session.id)).rejects.toMatchObject({code:'routine_not_found'})
    expect((await queryWithRLS(s.f.people.lead,'SELECT id FROM pending_approvals WHERE id=$1',[p.id])).rows).toHaveLength(0)
    await pool.query('UPDATE tasks SET scope_held=true WHERE id=$1',[s.source.id])
    expect(await listRoutineProposals(s.actor.userId,s.f.workspaceId,undefined,session.id)).toHaveLength(0)
    await pool.query('DELETE FROM sessions WHERE id=$1',[session.id])
    await expect(inspectRoutineProposal(s.actor.userId,p.id)).rejects.toMatchObject({code:'routine_not_found'})
  })

  it('I02/I11: Brian/agent raw tools cannot apply until actual human staged review, with no borrowed assistant grant',async()=>{
    const s=await proposalFixture()
    await createDbCapabilityStore().grant({assistantId:s.f.assistants.brian,capability:CONFIGURE_CAPABILITY,grantedByUserId:s.actor.userId})
    const p=await s.prepare(),tools=createRoutineTools(),store=createPendingApprovalsStore()
    const args={proposal_id:p.id,expected_revision:0,idempotency_key:randomUUID()}
    const context={userId:s.actor.userId,workspaceId:s.f.workspaceId,assistantId:s.f.assistants.brian,sessionId:randomUUID(),channelType:'brain_mcp',
      programmaticPrincipal:{kind:'brain_key',credentialId:randomUUID()}} as ToolContext
    expect((await tools.applyRoutineIntake.execute(args,context)).isError).toBe(true)
    const staged=await store.createStagedWrite({workspaceId:s.f.workspaceId,approverUserId:s.actor.userId,originatingAssistantId:s.f.assistants.brian,
      toolName:'applyRoutineIntake',toolInput:args,surface:'brain_mcp',credentialId:context.programmaticPrincipal!.credentialId})
    const deps={rawWrites:new Map(Object.values(tools).map(t=>[t.name,t]))}
    expect((await applyStagedWrite(deps,staged,s.actor.userId)).ok).toBe(false)
    expect((await applyStagedWrite(deps,{...staged,resolutionOrigin:'delegated_assistant'},s.actor.userId,{authSessionId:s.actor.authSessionId})).ok).toBe(false)
    expect((await applyStagedWrite(deps,{...staged,originatingAssistantId:null},s.actor.userId,{authSessionId:s.actor.authSessionId})).ok).toBe(false)
    const applied=await applyStagedWrite(deps,staged,s.actor.userId,{authSessionId:s.actor.authSessionId})
    expect(applied).toMatchObject({ok:true})
    expect((await pool.query('SELECT task_intake_applied_by FROM workflows WHERE id=$1',[p.arguments.workflowId])).rows[0].task_intake_applied_by).toBe(s.actor.userId)
    const result=await tools.getRoutineIntake.execute({proposal_id:p.id},context)
    expect(result.scopeEvidence?.sources?.map(r=>r.resourceId)).toContain(s.source.id)
  })
  it('I08: actual Task reads accumulate distinct admitted cases into one inactive contextual proposal without scanning or activation', async () => {
    const s=await setup()
    await createDbCapabilityStore().grant({assistantId:s.f.assistants.brian,capability:CONFIGURE_CAPABILITY,grantedByUserId:s.actor.userId})
    const scope=await resolveWorkflowAuthoringScope({userId:s.actor.userId,workspaceId:s.f.workspaceId,
      assistantId:s.f.assistants.brian,authoringAuthority:s.workflow.authoringAuthority!,contextGroupId:s.f.finance,contextProjectId:null})
    const context={...scope.access,sessionId:randomUUID(),channelType:'web',scopeAccumulator:new ContextScopeAccumulator()} as ToolContext
    const tasks=[]
    for (const day of ['2026-01-01','2026-01-02','2026-01-03']) tasks.push(await createTask(s.actor.userId,{
      workspaceId:s.f.workspaceId,title:`Prepare the weekly fictional summary ${day}`,home:{kind:'department',id:s.f.finance},
      executorAssistantId:s.f.assistants.brian,compartments:[`team:${s.f.finance}`],visibility:{userId:null,assistantId:null}}))
    const tools=createTaskTools(createDbTaskStore(),{onObserved:observeRoutineTasks})
    const read=async (id:string)=>{
      const result=await tools.getTask.execute({id},context)
      context.scopeAccumulator!.note(result.scopeEvidence)
      return result
    }
    await read(tasks[0].id); await read(tasks[0].id); await read(tasks[1].id)
    expect(await listRoutineProposals(s.actor.userId,s.f.workspaceId)).toHaveLength(0)
    const found=await read(tasks[2].id)
    expect(found.data).toHaveProperty('routineProposals')
    const proposals=await listRoutineProposals(s.actor.userId,s.f.workspaceId)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].arguments.sourceEvidence.sources).toHaveLength(3)
    expect(proposals[0].arguments.after.definition.defaultExecutor).toEqual(s.configuration.definition.defaultExecutor)
    await read(tasks[2].id)
    expect(await listRoutineProposals(s.actor.userId,s.f.workspaceId)).toHaveLength(1)
    expect((await pool.query('SELECT id FROM workflows WHERE id=$1',[proposals[0].arguments.workflowId])).rows).toHaveLength(0)
    expect((await pool.query('SELECT id FROM task_execution_pools WHERE workspace_id=$1',[s.f.workspaceId])).rows).toHaveLength(0)
  })

  it('I08: absence of current Configure authority keeps observed repetition conversational only', async()=>{
    const s=await setup()
    const scope=await resolveWorkflowAuthoringScope({userId:s.actor.userId,workspaceId:s.f.workspaceId,
      assistantId:s.f.assistants.brian,authoringAuthority:s.workflow.authoringAuthority!,contextGroupId:s.f.finance,contextProjectId:null})
    const context={...scope.access,sessionId:randomUUID(),channelType:'web'} as ToolContext
    const tools=createTaskTools(createDbTaskStore(),{onObserved:observeRoutineTasks})
    for (let n=1;n<=3;n++) await createTask(s.actor.userId,{workspaceId:s.f.workspaceId,title:`Review fictional operations report #${n}`,
      home:{kind:'department',id:s.f.finance},executorAssistantId:s.f.assistants.brian,compartments:[`team:${s.f.finance}`],visibility:{userId:null,assistantId:null}})
    await tools.listTasks.execute({limit:25,include_archived:false},context)
    expect(await listRoutineProposals(s.actor.userId,s.f.workspaceId)).toHaveLength(0)
  })
  it('I08: reserves one inactive proposal and creates no workflow, run, Task intake or allowance before human apply', async () => {
    const s = await proposalFixture()
    const proposals = await Promise.all(Array.from({length:4},s.prepare))
    expect(new Set(proposals.map(p=>p.id)).size).toBe(1)
    const p = proposals[0]
    expect(p).toMatchObject({status:'pending',arguments:{mode:'create',before:null}})
    expect(p.arguments.creation).toEqual({name:s.command.name,authoringAssistantId:s.f.assistants.brian})
    expect((await pool.query('SELECT id FROM workflows WHERE id=$1',[p.arguments.workflowId])).rows).toHaveLength(0)
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[p.arguments.workflowId])).rows).toHaveLength(0)
    expect((await pool.query('SELECT id FROM task_execution_pools WHERE workspace_id=$1',[s.f.workspaceId])).rows).toHaveLength(0)
    expect(await listRoutineProposals(s.actor.userId,s.f.workspaceId)).toHaveLength(1)
  })

  it('I01/I07: exact live human apply atomically creates the canonical workflow and records actual attribution once', async () => {
    const s = await proposalFixture()
    const p = await s.prepare()
    const command = {expectedRevision:0,idempotencyKey:randomUUID()}
    expect(await applyRoutineProposal(s.actor,p.id,command)).toEqual({revision:1,replayed:false})
    expect(await applyRoutineProposal(s.actor,p.id,command)).toEqual({revision:1,replayed:true})
    const row = (await pool.query('SELECT * FROM workflows WHERE id=$1',[p.arguments.workflowId])).rows[0]
    expect(row).toMatchObject({enabled:true,task_intake_revision:'1',task_intake_applied_by:s.actor.userId,task_intake_apply_receipt:p.id})
    expect(row.definition.taskIntake).toEqual(s.configuration.definition.taskIntake)
    const decision = (await pool.query('SELECT status,responded_by,resolution_origin FROM pending_approvals WHERE id=$1',[p.id])).rows[0]
    expect(decision).toEqual({status:'approved',responded_by:s.actor.userId,resolution_origin:'human'})
    expect(await listRoutineProposals(s.actor.userId,s.f.workspaceId)).toHaveLength(0)
    expect((await pool.query('SELECT count(*)::int n FROM workflows WHERE id=$1',[p.arguments.workflowId])).rows[0].n).toBe(1)
  })

  it('I07: a failed canonical insert rolls back the decision and can be retried without duplicate activation', async () => {
    const s = await proposalFixture()
    const p = await s.prepare()
    const name = `routine_fixture_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${p.arguments.workflowId}'::uuid THEN RAISE EXCEPTION 'fictional insertion failure'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON workflows FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    const command = {expectedRevision:0,idempotencyKey:randomUUID()}
    try {
      await expect(applyRoutineProposal(s.actor,p.id,command)).rejects.toThrow('fictional insertion failure')
      expect((await inspectRoutineProposal(s.actor.userId,p.id)).status).toBe('pending')
      expect((await pool.query('SELECT id FROM workflows WHERE id=$1',[p.arguments.workflowId])).rows).toHaveLength(0)
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON workflows`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
    expect(await applyRoutineProposal(s.actor,p.id,command)).toEqual({revision:1,replayed:false})
  })

  it('I08: rejection is an attributed idempotent decision and never materializes the proposed workflow', async () => {
    const s = await proposalFixture()
    const p = await s.prepare()
    const command = {expectedRevision:0,idempotencyKey:randomUUID()}
    expect(await rejectRoutineProposal(s.actor,p.id,command)).toEqual({replayed:false})
    expect(await rejectRoutineProposal(s.actor,p.id,command)).toEqual({replayed:true})
    expect((await inspectRoutineProposal(s.actor.userId,p.id)).status).toBe('rejected')
    expect((await pool.query('SELECT id FROM workflows WHERE id=$1',[p.arguments.workflowId])).rows).toHaveLength(0)
    await expect(applyRoutineProposal(s.actor,p.id,{expectedRevision:0,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'routine_revision_conflict'})
  })

  it('I02: incomplete configuration remains a draft and a fabricated human/tool receipt cannot apply it', async () => {
    const s = await proposalFixture()
    delete (s.command.configuration.definition as WorkflowDefinition).defaultExecutor
    const p = await s.prepare()
    await expect(applyRoutineProposal(s.actor,p.id,{expectedRevision:0,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'routine_executor_required'})
    await expect(applyRoutineProposal({kind:'tool',userId:s.actor.userId,approvalId:randomUUID()},p.id,
      {expectedRevision:0,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'routine_human_apply_required'})
    expect((await inspectRoutineProposal(s.actor.userId,p.id)).status).toBe('pending')
  })

  it('I10: private support floors cover raw app-role counts/detail and source revocation hides and fences the proposal', async () => {
    const s = await proposalFixture(true)
    await s.f.edge('user',s.f.people.lead)
    const p = await s.prepare()
    expect((await queryWithRLS(s.f.people.lead,'SELECT id FROM pending_approvals WHERE id=$1',[p.id])).rows).toHaveLength(0)
    expect(await listRoutineProposals(s.f.people.lead,s.f.workspaceId)).toHaveLength(0)
    await expect(inspectRoutineProposal(s.f.people.lead,p.id)).rejects.toMatchObject({code:'routine_not_found'})
    await pool.query('UPDATE tasks SET scope_held=true WHERE id=$1',[s.source.id])
    expect(await listRoutineProposals(s.actor.userId,s.f.workspaceId)).toHaveLength(0)
    expect((await queryWithRLS<{n:number}>(s.actor.userId,'SELECT count(*)::int n FROM pending_approvals WHERE id=$1',[p.id])).rows[0].n).toBe(0)
    await expect(applyRoutineProposal(s.actor,p.id,{expectedRevision:0,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'routine_not_found'})
  })

  it('I02: non-bypass app writers cannot mint decision proof or a canonical transaction capability', async () => {
    const s = await proposalFixture()
    const app = await getAppPool().connect()
    try {
      await app.query('BEGIN'); await applyRLSGucs(app,s.actor.userId)
      expect((await app.query('SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0].rolbypassrls).toBe(false)
      await expect(app.query(`INSERT INTO pending_approvals(workspace_id,kind,approver_user_id,tool_name,arguments,status,resolution_origin)
        VALUES($1,'tool_invocation',$2,'rejectRoutineIntake','{}','approved','human')`,[s.f.workspaceId,s.actor.userId])).rejects.toThrow(/row-level security/)
      await app.query('ROLLBACK')
    } finally { app.release() }
    await expect(s.store.create({userId:s.actor.userId,workspaceId:s.f.workspaceId,name:'Fictional forged transaction',
      definition:s.workflow.definition,authoringAuthority:s.workflow.authoringAuthority!}, {transaction:{}})).rejects.toMatchObject({code:'operational_authoring_proof_required'})
  })
})
