import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query } from '../../db/client.js'
import { approvalsRoutes } from '../approvals.js'
import { createPendingApprovalsStore, readBrowserSendApprovalStatus } from '../../db/pending-approvals-store.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import type { ApprovalBridgeDeps } from '../../workflow/approval.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })
describe('[COMP:api/pending-approvals-store] real departmental approval reads', () => {
  it('shows a sessionless staged card only to its designated approver, not the workspace queue', async () => {
    const workspace=randomUUID(),approver=randomUUID(),teammate=randomUUID(),admin=randomUUID()
    for(const user of [approver,teammate,admin]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Fictional staged fixture','test',$2,true)",[workspace,admin])
    for(const [user,role] of [[approver,'member'],[teammate,'member'],[admin,'owner']]) await query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role])
    const store=createPendingApprovalsStore()
    const card=await store.createStagedWrite({workspaceId:workspace,approverUserId:approver,toolName:'saveMemory',
      toolInput:{content:'Fictional departmental note'},surface:'brain_mcp',credentialId:randomUUID(),originatingAssistantId:null} as never)
    expect((await store.listPendingForWorkspace(approver,workspace)).map(row=>row.id)).toContain(card.id)
    for(const other of [teammate,admin]) {
      expect((await store.listPendingForWorkspace(other,workspace)).map(row=>row.id)).not.toContain(card.id)
      expect(await store.getById(other,card.id)).toBeNull()
    }
  })
  it('hides session-backed approval payloads and blocks stale responses after department revocation', async () => {
    const workspace=randomUUID(),owner=randomUUID(),viewer=randomUUID(),admin=randomUUID(),custodian=randomUUID(),department=randomUUID(),assistant=randomUUID(),project=randomUUID()
    for(const user of [owner,viewer,admin,custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Fictional roster fixture','test',$2,true)",[workspace,owner])
    for(const [user,role,tier] of [[owner,'owner','confidential'],[viewer,'member','public'],[admin,'admin','confidential'],[custodian,'member','confidential']]) await query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)',[workspace,user,role,tier])
    await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Protected fixture assistant',$2,'primary','confidential',$3)",[assistant,workspace,owner])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)",[department,workspace,custodian,`team:${department}`])
    await query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture project','fixture project',$3)",[project,workspace,owner])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,department,viewer])
    // A separate department custodian keeps owner seeding out of the no-edge actor cases.
    const ids:string[]=[]
    for(const visibility of ['workspace','owner']) {
      const id=randomUUID();ids.push(id)
      await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,visibility,effective_clearance,context_compartments,context_group_id,context_project_id,status,title) VALUES($1::uuid,$2,$3,$4,'web',$1::text,$5,'confidential',$6,$7,$8,'running','Protected fixture work')",[id,workspace,assistant,owner,visibility,[`team:${department}`],department,project])
    }
    const initialActivity=(await query('SELECT last_active_at FROM sessions WHERE id=$1',[ids[0]])).rows[0].last_active_at
    const store=createPendingApprovalsStore()
    const approval=await store.createToolInvocation({workspaceId:workspace,blockingSessionId:ids[0]!,originatingAssistantId:assistant,approverUserId:viewer,toolName:'fixtureMutation',arguments:{protected:'Fictional department payload'},deliveryChannelType:'web',approvalPayload:{}})
    const privateApproval=await store.createToolInvocation({workspaceId:workspace,blockingSessionId:ids[1]!,originatingAssistantId:assistant,approverUserId:viewer,toolName:'fixtureMutation',arguments:{protected:'Fictional private payload'},deliveryChannelType:'web',approvalPayload:{}})
    const app=express()
    app.use(express.json())
    app.use((req,_res,next)=>{Object.assign(req,{userId:req.header('x-fixture-user')});next()})
    app.use('/api/approvals',approvalsRoutes({approvalsStore:store,workspaceStore:createWorkspaceStore(),bridgeDeps:{} as ApprovalBridgeDeps,emailReviewContext:async()=>null}))
    const read=async(user:string)=>(await request(app).get('/api/approvals').query({workspaceId:workspace}).set('x-fixture-user',user).expect(200)).body.approvals
    expect((await read(viewer)).map((row:{id:string})=>row.id)).toEqual([approval.id])
    expect(await store.getById(viewer,privateApproval.id)).toBeNull()
    expect(await read(admin)).toEqual([])
    expect(await read(owner)).toEqual([])
    expect(await store.countPendingForUser(viewer)).toBe(1)
    // The admitted card reaches its native resume-path contract, not an authority denial.
    await request(app).post(`/api/approvals/${approval.id}/respond`).set('x-fixture-user',viewer).send({decision:'approved'}).expect(422)
    await query("UPDATE department_edges SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[workspace,viewer])
    expect(await read(viewer)).toEqual([])
    await query("UPDATE department_edges SET clearance='confidential',expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,viewer])
    expect(await read(viewer)).toEqual([])
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[workspace,viewer])
    expect(await read(viewer)).toEqual([])
    expect(await store.countPendingForUser(viewer)).toBe(0)
    await request(app).get('/api/approvals/count').query({workspaceId:workspace}).set('x-fixture-user',viewer).expect(200,{pending:0})
    await request(app).post(`/api/approvals/${approval.id}/respond`).set('x-fixture-user',viewer).send({decision:'approved'}).expect(404)
    expect((await store.getByIdSystem(approval.id))?.status).toBe('pending')
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,department,viewer])
    expect((await read(viewer)).map((row:{id:string})=>row.id)).toEqual([approval.id])
    expect((await query('SELECT last_active_at FROM sessions WHERE id=$1',[ids[0]])).rows[0].last_active_at).toEqual(initialActivity)
    const browserApproval=await store.createBrowserSkillSend({workspaceId:workspace,approverUserId:viewer,sessionId:ids[0],payload:{description:'Protected browser action'}})
    expect(await store.getById(viewer,browserApproval.id)).not.toBeNull()
    expect(await store.respond(browserApproval.id,'approved',viewer)).toBeNull()
    // Historical approved row: source-read renewal must still hide it after revocation.
    await query("UPDATE pending_approvals SET status='approved' WHERE id=$1",[browserApproval.id])
    expect(await readBrowserSendApprovalStatus(store,browserApproval.id)).toBe('approved')
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[workspace,viewer])
    expect(await readBrowserSendApprovalStatus(store,browserApproval.id)).toBe('unavailable')
    await expect(store.createBrowserSkillAudit({workspaceId:workspace,approverUserId:viewer,sessionId:ids[0],grantId:randomUUID(),payload:{description:'Revoked grant action'}})).rejects.toThrow('Browser approval source unavailable')
    expect((await store.getByIdSystem(browserApproval.id))?.status).toBe('approved')
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,department,viewer])
    expect(await readBrowserSendApprovalStatus(store,browserApproval.id)).toBe('approved')
    await query('DELETE FROM sessions WHERE id=$1',[ids[0]])
    expect(await read(viewer)).toEqual([])
    expect(await store.getById(viewer,approval.id)).toBeNull()
    expect(await store.getById(viewer,browserApproval.id)).toBeNull()
    await query('UPDATE pending_approvals SET source_session_required=false WHERE id=$1',[browserApproval.id])
    expect((await store.getByIdSystem(browserApproval.id))?.sourceSessionRequired).toBe(true)
    expect(await store.getById(viewer,browserApproval.id)).toBeNull()
    expect(await store.countPendingForUser(viewer)).toBe(0)
    await request(app).post(`/api/approvals/${browserApproval.id}/respond`).set('x-fixture-user',viewer).send({decision:'approved'}).expect(404)
    expect((await store.getByIdSystem(browserApproval.id))?.status).toBe('approved')
    expect(await readBrowserSendApprovalStatus(store,browserApproval.id)).toBe('unavailable')
    const independent=await store.createBrowserSkillSend({workspaceId:workspace,approverUserId:viewer,payload:{description:'Independent browser action'}})
    expect(await store.getById(viewer,independent.id)).not.toBeNull()
  })
})
