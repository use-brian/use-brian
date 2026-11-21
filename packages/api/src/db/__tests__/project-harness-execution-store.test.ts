import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarnessExecutionStore } from '../project-harness-execution-store.js'
import { buildVerificationPreview, runAutomaticVerification } from '../../project-harness/verification.js'

const mocks = vi.hoisted(() => {
  const query=vi.fn(), client={query}, connect=vi.fn(async()=>client)
  return {query,client,connect,applyRLSGucs:vi.fn(),rollbackAndRelease:vi.fn()}
})
vi.mock('../client.js',()=>({getPool:()=>({connect:mocks.connect}),applyRLSGucs:mocks.applyRLSGucs,rollbackAndRelease:mocks.rollbackAndRelease}))
const userId=randomUUID(), authSessionId=randomUUID(), actor={userId,authSessionId}, w=randomUUID(), p=randomUUID(), id=randomUUID(), aid=randomUUID(), rid=randomUUID()
const date='2026-01-01T00:00:00.000Z'
const definition={schemaVersion:1 as const,rules:[],codeChecks:[],acceptanceScenarios:[{key:'journey',title:'Journey',preconditions:['Ready'],steps:['Observe'],criteria:[{key:'visible',observation:'Visible',evidence:'Screenshot'}]}]}
const revision={id:rid,workspace_id:w,project_id:p,product_id:null,component_id:null,revision:1,created_by:randomUUID(),created_at:date,definition}
const input={approvalId:aid,scenarioKey:'journey',executor:'human' as const,build:{buildId:'b',deploymentId:'d'},target:{url:'https://example.com/',permittedOrigins:['https://example.com']},environment:{environmentId:'qa',locale:'en',timezone:'UTC',viewport:{width:100,height:100}}}
const preview=buildVerificationPreview({runId:id,revision:{id:rid,workspaceId:w,projectId:p,scope:{kind:'project'},revision:1,createdBy:revision.created_by,createdAt:date,definition},scenarioKey:input.scenarioKey,build:input.build,target:input.target,environment:input.environment})
const runRow={id,workspace_id:w,project_id:p,revision_id:rid,approval_id:aid,requested_by:userId,executor:'human',status:'pending',preview,result:null,created_at:date,started_at:null,expires_at:'2026-01-01T00:30:00.000Z',completed_at:null}
const approvalRow={id:aid,workspace_id:w,project_id:p,revision_id:rid,approved_by:userId,approved_at:date,reason:'Reviewed'}
const evidenceRow={id:randomUUID(),run_id:id,criterion_key:'visible',kind:'observation',provenance:'human_reported',text:'Seen',content_type:null,base64:null,sha256:'a'.repeat(64),created_at:date}
const store=createHarnessExecutionStore()
beforeEach(()=>{
  vi.clearAllMocks(); mocks.connect.mockResolvedValue(mocks.client)
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('harness_execution_approve')?[{result:approvalRow}]
    :sql.includes('JOIN public.project_harness_approvals')?[revision]
      :sql.startsWith('SELECT * FROM public.project_harness_runs')?[runRow]
        :sql.startsWith('SELECT * FROM public.project_harness_evidence')?[evidenceRow]
          :sql.includes('harness_execution_')?[{result:runRow}]:[]}))
})
describe('trusted harness execution store',()=>{
  it('maps approval and pins authenticated actor/session with canonical scope authorization',async()=>{
    expect(await store.approve(actor,w,p,rid,1,' Reviewed ')).toEqual({id:aid,workspaceId:w,projectId:p,revisionId:rid,approvedBy:userId,approvedAt:date,reason:'Reviewed'})
    expect(mocks.applyRLSGucs).toHaveBeenCalledWith(mocks.client,userId)
    expect(mocks.query.mock.calls[1]).toEqual(['SELECT public.project_harness_require($1,$2,NULL,NULL,false)',[w,p]])
    expect(mocks.query.mock.calls[2][1]).toEqual([w,p,rid,authSessionId,1,'Reviewed'])
    expect(mocks.rollbackAndRelease).toHaveBeenCalledWith(mocks.client)
  })
  it('builds packet only from persisted approved revision; client cannot inject packet or identity',async()=>{
    await store.createRun(actor,w,p,input)
    const call=mocks.query.mock.calls.find(([sql])=>sql.includes('harness_execution_create'))!
    expect(call[1].slice(0,4)).toEqual([w,p,aid,authSessionId])
    const packet=JSON.parse(call[1][6]); expect(packet.runId).toBe(call[1][4]); expect(packet.specification.revisionId).toBe(rid)
    expect(packet.scenario).toEqual(definition.acceptanceScenarios[0])
    expect(packet).not.toHaveProperty('createdBy')
    for(const extra of [{preview},{requestedBy:randomUUID()},{authSessionId:randomUUID()},{approval:{approved:true}},{executorIdentity:'trusted'}]) {
      await expect(store.createRun(actor,w,p,{...input,...extra} as never)).rejects.toMatchObject({code:'harness_invalid_input'})
    }
    expect(mocks.connect).toHaveBeenCalledTimes(1)
  })
  it('rejects invalid target and scenario against the persisted revision, without sending a create command',async()=>{
    await expect(store.createRun(actor,w,p,{...input,scenarioKey:'foreign'})).rejects.toMatchObject({code:'harness_invalid_input'})
    await expect(store.createRun(actor,w,p,{...input,target:{...input.target,url:'https://example.com/?secret=token'}})).rejects.toMatchObject({code:'harness_invalid_input'})
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('harness_execution_create'))).toBe(false)
  })
  it('returns camelCase run/evidence and hides stored auth sessions; getters expire runs',async()=>{
    const r=await store.run(userId,w,p,id)
    expect(r).toMatchObject({workspaceId:w,projectId:p,revisionId:rid,approvalId:aid,requestedBy:userId,createdAt:date,startedAt:null,result:null})
    expect(r).not.toHaveProperty('auth_session_id'); expect(r).not.toHaveProperty('workspace_id')
    const [e]=await store.evidence(userId,w,p,id)
    expect(e).toMatchObject({runId:id,criterionKey:'visible',contentType:null,provenance:'human_reported',createdAt:date})
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('harness_execution_expire'))).toBe(true)
  })
  it('validates results against stored preview before the SQL evidence/authority check',async()=>{
    const result=runAutomaticVerification(preview)
    await store.completeHuman(actor,w,p,id,result)
    expect(mocks.query.mock.calls.find(([sql])=>sql.includes('harness_execution_action'))?.[1]).toEqual([w,p,id,authSessionId,'complete_human',JSON.stringify(result)])
    vi.clearAllMocks()
    await expect(store.completeHuman(actor,w,p,id,{...result,binding:{...result.binding,runId:randomUUID()}})).rejects.toMatchObject({code:'harness_invalid_input'})
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('harness_execution_action'))).toBe(false)
  })
  it('sends human observations only; validates bounded canonical PNG bytes before touching DB',async()=>{
    await expect(store.addHumanEvidence(actor,w,p,id,{criterionKey:'visible',text:'Seen',provenance:'isolated_browser'} as never)).rejects.toMatchObject({code:'harness_invalid_input'})
    for(const base64 of ['abc',Buffer.alloc(50).toString('base64'),'A'.repeat(2796205)]) await expect(store.addAgentEvidence(userId,w,p,id,{criterionKey:'visible',base64})).rejects.toMatchObject({code:'harness_invalid_input'})
    expect(mocks.connect).not.toHaveBeenCalled()
    const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII='
    await store.addAgentEvidence(userId,w,p,id,{criterionKey:'visible',base64})
    expect(mocks.query.mock.calls.find(([sql])=>sql.includes('harness_execution_action'))?.[1]).toEqual([w,p,id,null,'evidence_agent',JSON.stringify({criterionKey:'visible',base64})])
  })
  it('validates complete list ancestry and never interpolates scope values',async()=>{
    const productId=randomUUID(),componentId=randomUUID()
    await store.runs(userId,w,p,{kind:'component',productId,componentId})
    expect(mocks.query.mock.calls.find(([sql])=>sql.includes('project_harness_require($1,$2,$3'))?.[1]).toEqual([w,p,productId,componentId])
    await expect(store.approvals(userId,w,p,{kind:'project',productId} as never)).rejects.toMatchObject({code:'harness_invalid_input'})
  })
  it('maps SQL failures without leaking detail or connection errors; releases on failure',async()=>{
    for(const [failure,code,status] of [
      [new Error('harness_human_required'),'harness_human_required',403],
      [new Error('harness_revision_stale'),'harness_revision_stale',409],
      [Object.assign(new Error('secret'),{code:'23514',detail:'private payload'}),'harness_invalid_input',400],
      [Object.assign(new Error('secret'),{code:'40001'}),'harness_run_conflict',409],
      [new Error('secret'),'harness_unavailable',503],
    ] as const) {
      mocks.query.mockRejectedValueOnce(failure)
      await expect(store.run(userId,w,p,id)).rejects.toMatchObject({code,status,message:code})
    }
    expect(mocks.rollbackAndRelease).toHaveBeenCalledTimes(5)
    mocks.connect.mockRejectedValueOnce(new Error('secret database URL'))
    await expect(store.run(userId,w,p,id)).rejects.toMatchObject({code:'harness_unavailable',message:'harness_unavailable'})
  })
})
