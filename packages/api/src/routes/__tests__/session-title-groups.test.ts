import {beforeEach,describe,expect,it,vi} from 'vitest'
import {bindScopeSources} from '@use-brian/core'
const mocks=vi.hoisted(()=>({query:vi.fn(),resolve:vi.fn(),group:vi.fn(),output:vi.fn(),head:vi.fn(),read:vi.fn()}))
vi.mock('../../db/client.js',()=>({getPool:()=>({query:mocks.query})}))
vi.mock('../../db/auth-session-store.js',()=>({authSessionStore:{validateAccess:vi.fn(async()=>true)}}))
vi.mock('../../db/sessions.js',()=>({readSessionById:vi.fn(async(id:string)=>({id,assistantId:'assistant',workspaceId:'workspace',userId:'actor',channelType:'web',channelId:id,visibility:'personal',anchorKind:'none'}))}))
vi.mock('../../db/users.js',()=>({getUserAssistant:vi.fn(async()=>({id:'assistant',workspaceId:'workspace'}))}))
vi.mock('../../db/session-query-reader.js',()=>({readAdmittedSessionQuery:vi.fn()}))
vi.mock('../../db/session-title-store.js',()=>({publishSessionTitle:vi.fn(),readSessionTitle:mocks.read,readSessionTitlesGrouped:mocks.group,sessionTitleHead:mocks.head}))
vi.mock('../../context-scope/execution-context.js',()=>({resolveExecutionContextSystem:mocks.resolve}))
vi.mock('../../session-read-authority.js',()=>({gateSessionRead:vi.fn(async()=>null)}))
vi.mock('../../application-platform/model-source-authority.js',()=>({assertSourceModelOutputAuthority:mocks.output}))
import {sessionTitleProjections} from '../session-title-authority.js'
const claims={userId:'actor'},ids=['first','second','third','fourth']
function title(id:string){return bindScopeSources({title:'Fictional '+id,manual:false,revisionId:id+'-revision'},[])}
function execution(input:any,override:any={}){
 const access={userId:'actor',workspaceId:'workspace',assistantId:'assistant',clearance:'internal',compartments:[],projectIds:[],sharedAudience:false}
 return{executionContext:{identity:input.identity,ownership:input.ownership,assistant:input.assistant,surface:input.surface,lifecycle:input.lifecycle,
  security:{access,writeDefaults:{compartments:[],projectIds:[]},ceiling:{...access,...override},provenance:{},authority:{assertCurrent:async()=>{}}}}}
}
beforeEach(()=>{
 vi.resetAllMocks()
 mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('title_candidates')?ids.map(id=>({id})):ids.map(id=>({sessionId:id,revisionId:id+'-revision',
  source:{held:false,resourceKind:'session_context_revision',resourceId:id+'-revision',version:'1'}}))}))
 mocks.resolve.mockImplementation(async input=>execution(input))
 mocks.head.mockImplementation(async id=>id+'-revision');mocks.read.mockImplementation(async id=>title(id))
 mocks.group.mockImplementation(async heads=>new Map(heads.map((head:{sessionId:string})=>[head.sessionId,title(head.sessionId)])))
 mocks.output.mockResolvedValue(undefined)
})
describe('[COMP:api/application-persistence] bounded title group context partition',()=>{
 it('groups equal SQL contexts while keeping individual original authorities',async()=>{
  const result=await sessionTitleProjections({claims,sessionIds:ids})
  expect(mocks.group).toHaveBeenCalledTimes(1);expect(mocks.read).not.toHaveBeenCalled()
  expect([...result.values()].map(value=>value.title)).toEqual(ids.map(id=>'Fictional '+id))
  expect(mocks.resolve).toHaveBeenCalledTimes(5)
 })
 for(const difference of ['clearance','compartments','projectIds','assistantVisibility']as const)it(`does not combine different ${difference} ceilings`,async()=>{
  mocks.resolve.mockImplementation(async input=>execution(input,input.session.id==='second'?{[difference]:difference==='clearance'?'confidential':['fictional']}:{ }))
  await sessionTitleProjections({claims,sessionIds:ids.slice(0,2)})
  expect(mocks.group).not.toHaveBeenCalled();expect(mocks.read).toHaveBeenCalledTimes(2)
 })
 it('keeps repeated session identities on fresh individual boundaries',async()=>{
  await sessionTitleProjections({claims,sessionIds:['first','second','first','second']})
  expect(mocks.group).not.toHaveBeenCalled();expect(mocks.read).toHaveBeenCalledTimes(4)
 })
 it('collects equal contexts across different-context entries and restores request order',async()=>{
  const events:string[]=[]
  mocks.resolve.mockImplementation(async input=>execution(input,input.session.id==='second'?{clearance:'confidential'}:{}))
  mocks.read.mockImplementation(async id=>{events.push('read:'+id);return title(id)})
  mocks.group.mockImplementation(async heads=>{events.push('group:'+heads.map((head:any)=>head.sessionId).join(','));return new Map(heads.map((head:any)=>[head.sessionId,title(head.sessionId)]))})
  const result=await sessionTitleProjections({claims,sessionIds:ids})
  expect(mocks.group).toHaveBeenCalledTimes(1)
  expect(events).toEqual(['group:first,third,fourth','read:second'])
  expect([...result.keys()]).toEqual(ids)
  expect([...result.values()].map(value=>value.title)).toEqual(ids.map(id=>'Fictional '+id))
 })
 it('uses held metadata only to exclude optional grouping and still reads that row freshly',async()=>{
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('title_candidates')?ids.map(id=>({id})):ids.map(id=>({sessionId:id,revisionId:id+'-revision',
   source:id==='second'?{held:true}:{held:false,resourceKind:'session_context_revision',resourceId:id+'-revision',version:'1'}}))}))
  const result=await sessionTitleProjections({claims,sessionIds:ids})
  expect(mocks.read).toHaveBeenCalledTimes(1);expect(mocks.read.mock.calls[0][0]).toBe('second')
  expect(mocks.group.mock.calls[0][0].map((head:any)=>head.sessionId)).toEqual(['first','third','fourth'])
  expect([...result.keys()]).toEqual(ids)
  expect(result.get('second')?.title).toBe('Fictional second')
 })
 it('caps failed optional probes before unchanged row fallback',async()=>{
  const many=Array.from({length:50},(_,index)=>'fictional-'+index)
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('title_candidates')?many.map(id=>({id})):many.map(id=>({sessionId:id,revisionId:id+'-revision',
   source:{held:false,resourceKind:'session_context_revision',resourceId:id+'-revision',version:'1'}}))}));mocks.group.mockResolvedValue(null)
  const result=await sessionTitleProjections({claims,sessionIds:many})
  expect(mocks.group).toHaveBeenCalledTimes(3);expect(mocks.read).toHaveBeenCalledTimes(50)
  expect([...result.values()].map(value=>value.title)).toEqual(many.map(id=>'Fictional '+id))
 })
 it('falls back on a bounded union overflow but does not hide unexpected failures',async()=>{
  mocks.group.mockRejectedValue(Object.assign(new Error('scope_ancestry_unavailable'),{code:'22023'}))
  expect((await sessionTitleProjections({claims,sessionIds:ids})).size).toBe(ids.length)
  expect(mocks.read).toHaveBeenCalledTimes(ids.length)
  mocks.group.mockRejectedValue(new Error('Fictional storage unavailable'))
  await expect(sessionTitleProjections({claims,sessionIds:ids})).rejects.toThrow('Fictional storage unavailable')
 })
 it('keeps shared-audience readers on their individual authority path',async()=>{
  mocks.resolve.mockImplementation(async input=>{const result=execution(input);result.executionContext.security.access.sharedAudience=true;return result})
  await sessionTitleProjections({claims,sessionIds:ids})
  expect(mocks.group).not.toHaveBeenCalled();expect(mocks.read).toHaveBeenCalledTimes(ids.length)
 })
 it('attempts a successful half only at its first row and does not cross awaited fallback rows',async()=>{
  const events:string[]=[]
  mocks.group.mockImplementation(async heads=>{events.push('group:'+heads.map((head:any)=>head.sessionId).join(','));return heads.length===4?null:new Map(heads.map((head:any)=>[head.sessionId,title(head.sessionId)]))})
  await sessionTitleProjections({claims,sessionIds:ids})
  expect(events).toEqual(['group:first,second,third,fourth','group:first,second','group:third,fourth'])
  expect(mocks.read).not.toHaveBeenCalled()
 })
})
