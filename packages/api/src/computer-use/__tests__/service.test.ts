import { it,expect,vi,beforeEach } from 'vitest'
vi.mock('../../db/client.js',()=>({query:vi.fn()}))
import { query } from '../../db/client.js'
import { NativeComputerService } from '../service.js'
import type { NativeGrant, NativeCommand } from '@use-brian/computer-control/protocol.js'
import { composeNativeComputerTool } from '../composition.js'
import type { Tool, ToolContext } from '@use-brian/core'
import { createHash } from 'node:crypto'
const q=vi.mocked(query)
const scope={userId:'user',workspaceId:'workspace',assistantId:'assistant',conversationId:'conversation',taskId:'task'}
const service=()=>new NativeComputerService({relayUrl:'http://relay',relaySecret:'relay-secret',jwtSecret:'jwt',deploymentId:'deployment'})
beforeEach(()=>vi.resetAllMocks())
it('membership/capability/task/conversation denial prevents creation',async()=>{
 q.mockResolvedValue({rows:[]} as never)
 await expect(service().create({...scope,deviceId:'device',challenge:'challenge',authSessionId:'auth'})).rejects.toThrow('scope denied')
 expect(q).toHaveBeenCalledTimes(1)
 const sql=q.mock.calls[0][0] as string
 for(const predicate of ['workspace_members',"c.capability='native_computer'",'c.revoked_at IS NULL','s.user_id=$1','t.user_id=$1','t.assistant_id=a.id'])expect(sql).toContain(predicate)
})
it('revoked/expired auth-backed session fails before relay dispatch',async()=>{
 q.mockResolvedValue({rows:[]} as never)
 await expect(service().status('session','user')).rejects.toThrow('unavailable')
 expect(q.mock.calls[0][0]).toContain('a.auth_version=u.auth_version')
 expect(q.mock.calls[0][0]).toContain('a.revoked_at IS NULL')
})
it('bad verifier never consumes pairing or contacts relay',async()=>{
 const row={...scope,id:'session',deviceId:'device',deploymentId:'deployment',challenge:createHash('sha256').update('correct').digest('base64url'),epoch:0,state:'awaiting_local_consent',expiresAt:new Date(Date.now()+60_000)}
 q.mockResolvedValueOnce({rows:[row]} as never).mockResolvedValueOnce({rows:[{}]} as never)
 const s=service();const relay=vi.spyOn(s,'relay')
 await expect(s.exchange('session','user','incorrect',{protocol:'native-computer-v1',identity:{deploymentId:'deployment',deviceId:'device',sessionId:'session',userId:'user',workspaceId:'workspace',conversationId:'conversation',taskId:'task'},grantId:'grant',epoch:0,expiresAt:Date.now()+60_000,targets:[{appId:'app',processId:1,processInstanceId:'p',windowId:'w',windowInstanceId:'wi'}],allowControl:false,allowCapture:false,requester:'user',goal:'inspect'})).rejects.toThrow('pairing denied')
 expect(q).toHaveBeenCalledTimes(2);expect(relay).not.toHaveBeenCalled()
})
it('positive fresh-consent epoch is persisted atomically and grant retained only ephemerally',async()=>{
 const verifier='x'.repeat(43)
 const row={...scope,id:'session',deviceId:'device',deploymentId:'deployment',challenge:createHash('sha256').update(verifier).digest('base64url'),epoch:0,state:'awaiting_local_consent',expiresAt:new Date(Date.now()+60_000)}
 const grant={protocol:'native-computer-v1',identity:{deploymentId:'deployment',deviceId:'device',sessionId:'session',userId:'user',workspaceId:'workspace',conversationId:'conversation',taskId:'task'},grantId:'grant',epoch:7,expiresAt:Date.now()+60_000,targets:[{appId:'app',processId:1,processInstanceId:'p',windowId:'w',windowInstanceId:'wi'}],allowControl:true,allowCapture:false,requester:'user',goal:'inspect'}
 q.mockResolvedValueOnce({rows:[row]} as never).mockResolvedValueOnce({rows:[{}]} as never).mockResolvedValueOnce({rows:[{id:'session'}]} as never).mockResolvedValue({rows:[]} as never)
 const s=service();vi.spyOn(s,'relay').mockResolvedValue({ok:true})
 const result=await s.exchange('session','user',verifier,grant)
 expect(result.token).toBeTruthy();expect(q.mock.calls[2][1]).toEqual(['session','user','grant',new Date(grant.expiresAt),7])
 expect(JSON.stringify(q.mock.calls)).not.toContain('inspect')
 q.mockReset();q.mockResolvedValueOnce({rows:[{...row,state:'active',epoch:7,grantId:'grant'}]} as never).mockResolvedValueOnce({rows:[{}]} as never)
 expect((await s.binding(scope))?.grant.epoch).toBe(7)
 expect(await s.binding({...scope,conversationId:'forged'})).toBeNull()
})
it('unknown outcome leaves durable latch and revokes relay authority',async()=>{
 const s=service();q.mockResolvedValue({rows:[{}]} as never);const relay=vi.spyOn(s,'relay').mockResolvedValue({ok:true})
 await s.markUnknown('session','user')
 expect(q.mock.calls[0][0]).toContain("state='execution_unknown'")
 expect(q.mock.calls[0][0]).toContain('revoked_at=COALESCE')
 expect(relay).toHaveBeenCalledWith('/sessions/session','DELETE')
})
it('run rejects another auth session and returns metadata for consumed grants without tool execution',async()=>{
 const s=service();const execute=vi.fn();const tool={execute} as never
 q.mockResolvedValueOnce({rows:[]} as never)
 await expect(s.run('session','user','other',tool,new AbortController().signal)).rejects.toThrow('unavailable')
 expect(q.mock.calls[0][1]).toEqual(['session','user','other'])
 q.mockResolvedValueOnce({rows:[{...scope,id:'session',runState:'running'}]} as never).mockResolvedValueOnce({rows:[{}]} as never).mockResolvedValueOnce({rows:[]} as never)
 expect(await s.run('session','user','auth',tool,new AbortController().signal)).toEqual({sessionId:'session',duplicate:true,runState:'running'})
 expect(execute).not.toHaveBeenCalled()
})
it('claim uses a durable atomic once-only latch and block policy denies',async()=>{
 const { s } = await paired(true); const grant=(await s.binding(scope))!.grant
 vi.spyOn(s,'assertCurrent').mockResolvedValue()
 q.mockReset()
 q.mockResolvedValueOnce({rows:[{policy:'block'}]} as never)
 await expect(s.claimRun(scope,grant)).rejects.toThrow('blocked')
 q.mockResolvedValueOnce({rows:[]} as never).mockResolvedValueOnce({rows:[{id:'session'}]} as never)
 expect(await s.claimRun(scope,grant)).toBe(true)
 expect(q.mock.calls.at(-1)?.[0]).toContain('run_state IS NULL')
 q.mockResolvedValue({rows:[]} as never)
 expect(await s.claimRun(scope,grant)).toBe(false)
})

async function paired(allowControl: boolean) {
 const s = service(); const verifier = 'v'.repeat(43)
 const grant: NativeGrant = { protocol:'native-computer-v1', identity:{deploymentId:'deployment',deviceId:'device',sessionId:'session',userId:'user',workspaceId:'workspace',conversationId:'conversation',taskId:'task'}, grantId:'grant',epoch:7,expiresAt:Date.now()+60_000,targets:[{appId:'app',processId:1,processInstanceId:'p',windowId:'w',windowInstanceId:'wi'}],allowControl,allowCapture:false,requester:'user',goal:'inspect' }
 const row = { ...scope, id:'session', deviceId:'device',deploymentId:'deployment',challenge:createHash('sha256').update(verifier).digest('base64url'),epoch:7,state:'active',expiresAt:new Date(grant.expiresAt),grantId:'grant',authSessionId:'auth',runState:null }
 q.mockImplementation(async sql => ({ rows: String(sql).includes('SELECT id,user_id') ? [row] : String(sql).includes('mcp_tool_settings') ? [] : [{id:'session'}] }) as never)
 const relay = vi.spyOn(s,'relay').mockResolvedValue({ok:true})
 await s.exchange('session','user',verifier,grant)
 relay.mockClear(); q.mockClear()
 return { s, grant, relay }
}
it('local inspector denies concurrent POST run, composed model tool, claims and API reads without workers or AX',async()=>{
 const { s, grant, relay } = await paired(false)
 const runtime = vi.fn(); const execute = vi.fn()
 const tool = composeNativeComputerTool(s,runtime)
 const context: ToolContext = {userId:'user',workspaceId:'workspace',assistantId:'assistant',sessionId:'conversation',appId:'test',channelType:'web',channelId:'c',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal}
 const command: NativeCommand = { protocol:grant.protocol,identity:grant.identity,grantId:grant.grantId,epoch:grant.epoch,commandId:'remote',deadlineAt:Date.now()+30_000,action:{kind:'observe',target:grant.targets[0]} }
 const [post, composed, claimed, dispatched, forgedClaim] = await Promise.all([
  s.run('session','user','auth',{execute} as never,context.abortSignal),
  tool.execute({goal:grant.goal},context), s.claimRun(scope,grant), s.dispatch(scope,command),
  s.claimRun(scope,{...grant,allowControl:true}),
 ])
 expect(post).toEqual({sessionId:'session',data:{outcome:'unsupported',reason:'local_inspector_only'},isError:true})
 expect(composed.isError).toBe(true); expect(claimed).toBe(false); expect(forgedClaim).toBe(false)
 expect(dispatched).toEqual({commandId:'remote',outcome:'not_executed',code:'denied'})
 expect(runtime).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(relay).not.toHaveBeenCalled()
 expect(await s.binding(scope)).toBeNull()
 expect(q.mock.calls.some(([sql])=>String(sql).includes("SET run_state='running'") || String(sql).includes("SET state='execution_unknown'"))).toBe(false)
})
it('full-control grants still dispatch scoped AX and POST run executes its tool',async()=>{
 const { s, grant, relay } = await paired(true)
 const command: NativeCommand = {protocol:grant.protocol,identity:grant.identity,grantId:grant.grantId,epoch:grant.epoch,commandId:'control-read',deadlineAt:Date.now()+30_000,action:{kind:'observe',target:grant.targets[0]}}
 relay.mockResolvedValue({commandId:command.commandId,outcome:'executed',code:'ok'})
 expect((await s.dispatch(scope,command)).code).toBe('ok')
 expect(relay).toHaveBeenCalledWith('/command','POST',expect.objectContaining({action:command.action}))
 const execute=vi.fn().mockResolvedValue({data:{outcome:'completed'}})
 expect(await s.run('session','user','auth',{execute} as never,new AbortController().signal)).toMatchObject({data:{outcome:'completed'}})
 expect(execute).toHaveBeenCalledOnce()
})

// Exercise the real service.run -> composition seam with two separately paired
// devices. SQL/auth are fixtures; resolution, claims and teardown are production.
async function pairedSessions(sameGoal: boolean, sameTask: boolean) {
 const s = service(), verifier = 'v'.repeat(43)
 const grants = ['A','B'].map(label => ({
  protocol:'native-computer-v1' as const,
  identity:{deploymentId:'deployment',deviceId:`device-${label}`,sessionId:`session-${label}`,userId:scope.userId,workspaceId:scope.workspaceId,conversationId:scope.conversationId,taskId:sameTask ? scope.taskId : `task-${label}`},
  grantId:`grant-${label}`,epoch:1,expiresAt:Date.now()+60_000,
  targets:[{appId:'com.apple.TextEdit',processId:1,processInstanceId:`p-${label}`,windowId:'w',windowInstanceId:`wi-${label}`}],
  allowControl:true,allowCapture:false,requester:'user',goal:sameGoal ? 'Write a greeting' : `Write greeting ${label}`,
 }))
 const rows = new Map(grants.map(g => [g.identity.sessionId, {
  ...scope,taskId:g.identity.taskId,id:g.identity.sessionId,deviceId:g.identity.deviceId,deploymentId:'deployment',
  challenge:createHash('sha256').update(verifier).digest('base64url'),epoch:g.epoch,state:'active',
  expiresAt:new Date(g.expiresAt),grantId:g.grantId,authSessionId:'auth',runState:null as string|null,revoked:false,
 }]))
 q.mockImplementation(async (sql,params) => {
  const text=String(sql), row=rows.get(String(params?.[0]))
  if(text.startsWith('SELECT id,user_id')) return {rows:row && !row.revoked ? [{...row}] : []} as never
  if(text.startsWith('SELECT 1 FROM sessions')) return {rows:[{}]} as never
  if(text.startsWith('SELECT policy')) return {rows:[]} as never
  if(text.includes("SET run_state='running'")) {
   if(!row || row.revoked || row.runState || row.state!=='active' || row.grantId!==params?.[1]) return {rows:[]} as never
   row.runState='running'
  }
  if(text.includes('SET revoked_at=now()') && row) row.revoked=true
  if(text.includes('SET run_state=CASE') && row) row.runState=String(params?.[2])
  return {rows:row ? [{id:row.id}] : []} as never
 })
 const relay=vi.spyOn(s,'relay').mockResolvedValue({ok:true})
 for(const grant of grants) await s.exchange(grant.identity.sessionId,'user',verifier,grant)
 q.mockClear();relay.mockClear()
 const context:ToolContext={userId:scope.userId,workspaceId:scope.workspaceId,assistantId:scope.assistantId,sessionId:scope.conversationId,appId:'test',channelType:'web',channelId:'session-B',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal}
 return {s,grants,rows,verifier,relay,context}
}

it.each([[true,true],[true,false],[false,true],[false,false]])('direct run B stays on B (same goal=%s, same task=%s)',async(sameGoal,sameTask)=>{
 const {s,grants,context,relay}=await pairedSessions(sameGoal,sameTask)
 const runtime=vi.fn().mockResolvedValue(null),claim=vi.spyOn(s,'claimRun'),finish=vi.spyOn(s,'finishRun')
 const tool=composeNativeComputerTool(s,runtime)
 await s.run('session-B','user','auth',tool,context.abortSignal)
 expect(claim).toHaveBeenCalledTimes(1)
 expect(claim.mock.calls[0][1]).toEqual(grants[1])
 expect(claim.mock.calls[0][0].taskId).toBe(grants[1].identity.taskId)
 expect(runtime).toHaveBeenCalledTimes(1)
 expect(runtime.mock.calls[0][1]).toEqual(grants[1])
 expect(finish).toHaveBeenCalledExactlyOnceWith('session-B','user',false)
 expect(relay).toHaveBeenCalledExactlyOnceWith('/sessions/session-B','DELETE')
 expect(q.mock.calls.filter(([sql])=>String(sql).includes("SET run_state='running'")).map(([,params])=>params?.[0])).toEqual(['session-B'])
})

it.each([[true,true],[true,false],[false,true],[false,false]])('generic ambiguous grants deny before claim or inference (same goal=%s, same task=%s)',async(sameGoal,sameTask)=>{
 const {s,grants,context}=await pairedSessions(sameGoal,sameTask)
 const runtime=vi.fn(),claim=vi.spyOn(s,'claimRun')
 // channelId and model-supplied session fields cannot select a device.
 const result=await composeNativeComputerTool(s,runtime).execute({goal:grants[1].goal,sessionId:'session-B'},context)
 expect(result.isError).toBe(true)
 expect(claim).not.toHaveBeenCalled();expect(runtime).not.toHaveBeenCalled()
})

it('generic task filters still disambiguate and empty/foreign task scopes deny',async()=>{
 const {s,grants}=await pairedSessions(true,false)
 expect((await s.binding(scope,['task-B']))?.grant).toEqual(grants[1])
 expect(await s.binding(scope,[])).toBeNull()
 expect(await s.binding(scope,['foreign'])).toBeNull()
})

it.each(['revoke-before','revoke-during','replace-before','replace-during'] as const)('pinned run never falls back to A on %s',async mode=>{
 const {s,grants,verifier,context}=await pairedSessions(true,true)
 const runtime=vi.fn(),claim=vi.spyOn(s,'claimRun'),composed=composeNativeComputerTool(s,runtime)
 const invalidate=async()=>{
  if(mode.startsWith('revoke')) await s.revoke('session-B','user')
  else {
   // Even replacement with identical wire identity must not revive the old pin.
   await s.exchange('session-B','user',verifier,{...grants[1],goal:'Replacement goal'})
  }
 }
 const tool={...composed,async execute(input:unknown,ctx:ToolContext){
  if(mode.endsWith('before')) await invalidate()
  else vi.spyOn(s,'authorized').mockImplementationOnce(async()=>{await invalidate();return true})
  return composed.execute(input,ctx)
 }}
 expect(await s.run('session-B','user','auth',tool,context.abortSignal)).toMatchObject({isError:true})
 expect(claim).not.toHaveBeenCalled();expect(runtime).not.toHaveBeenCalled()
 // A remained eligible, so a fallback would have reached the claim.
 await s.revoke('session-B','user')
 expect((await s.binding(scope))?.grant).toEqual(grants[0])
})

it.each([false,true])('run context pin is object-specific and removed on completion (throws=%s)',async throws=>{
 const {s,grants,context}=await pairedSessions(true,true)
 let retained!:ToolContext
 const tool={async execute(_input:unknown,ctx:ToolContext){
  retained=ctx
  expect((await s.binding(scope,undefined,ctx))?.grant).toEqual(grants[1])
  expect(await s.binding(scope,undefined,{...ctx})).toBeNull()
  expect(await s.binding(scope,[],ctx)).toBeNull()
  expect(await s.binding({...scope,assistantId:'other'},undefined,ctx)).toBeNull()
  if(throws) throw new Error('test failure')
  return {data:'done'}
 }} as Tool
 const run=s.run('session-B','user','auth',tool,context.abortSignal)
 if(throws) await expect(run).rejects.toThrow('test failure')
 else await run
 expect(await s.binding(scope,undefined,retained)).toBeNull()
 await s.revoke('session-B','user')
 expect((await s.binding(scope))?.grant).toEqual(grants[0])
 expect(await s.binding(scope,undefined,retained)).toBeNull() // No late fallback to sole remaining A.
 expect(await s.binding(scope,undefined,{...retained})).toBeNull() // Middleware cloning cannot turn a direct run into generic resolution.
 expect(await s.binding(scope,undefined,{...context,channelType:'native-computer',channelId:'session-A'})).toBeNull() // Channel metadata is not a pin.
})

it('claim rejects a replacement grant after policy authorization awaits',async()=>{
 const {s,grants,verifier}=await pairedSessions(true,true)
 const tool={async execute(_input:unknown,ctx:ToolContext){
  const original=(await s.binding(scope,undefined,ctx))!.grant
  vi.spyOn(s,'assertPolicy').mockImplementationOnce(async()=>{await s.exchange('session-B','user',verifier,grants[1])})
  expect(await s.claimRun(scope,original)).toBe(false)
  return {data:'done'}
 }} as Tool
 await s.run('session-B','user','auth',tool,new AbortController().signal)
 expect(q.mock.calls.some(([sql])=>String(sql).includes("SET run_state='running'"))).toBe(false)
})

it.each(['auth','capability','policy','digest','epoch','grantId','commandId','deadlineAt','foreign','success'] as const)('pending execution revalidation: %s', async mode => {
 const {s,grant,relay}=await paired(true)
 let finish!: (v: unknown)=>void
 let wire!: NativeCommand
 relay.mockImplementation(async (path,_method,body)=>{
  if(path==='/command') {wire=body as NativeCommand; return new Promise(resolve=>{finish=resolve})}
  return {}
 })
 const command:NativeCommand={protocol:grant.protocol,identity:grant.identity,grantId:grant.grantId,epoch:grant.epoch,commandId:'pending',deadlineAt:Date.now()+30000,action:{kind:'observe',target:grant.targets[0]}}
 const dispatch=s.dispatch(scope,command)
 await vi.waitFor(()=>expect(wire).toBeDefined())
 const check={commandId:wire.commandId,grantId:wire.grantId,epoch:wire.epoch,deadlineAt:wire.deadlineAt,digest:createHash('sha256').update(JSON.stringify(wire)).digest('hex')}
 q.mockClear()
 q.mockImplementation(async (sql, params)=>({rows:String(sql).startsWith('SELECT 1 FROM native_computer_sessions n')
   ? ['auth','capability','policy'].includes(mode) || params?.[2] !== 'auth' ? [] : [{}]
   : [{}]}) as never)
 const altered={...check}
 if(mode==='digest') altered.digest='0'.repeat(64)
 if(mode==='epoch') altered.epoch++
 if(mode==='grantId') altered.grantId='other'
 if(mode==='commandId') altered.commandId='other'
 if(mode==='deadlineAt') altered.deadlineAt++
 const validation=s.revalidate('session','user',mode==='foreign'?'other':'auth',altered)
 if(mode==='success') {
  expect(await validation).toEqual({authorized:true})
  expect(q).toHaveBeenCalledTimes(1)
  expect(q.mock.calls[0][1]).toEqual(['session','user','auth','workspace','assistant','conversation','task','grant',7,'deployment','device'])
 }
 else await expect(validation).rejects.toThrow()
 finish({commandId:wire.commandId,outcome:'not_executed',code:'denied'}); await dispatch
 await expect(s.revalidate('session','user','auth',check)).rejects.toThrow()
 expect(JSON.stringify(q.mock.calls)).not.toContain('"action"')
})

it.each(['revoke','expiry'] as const)('pending authority cannot survive %s during the atomic authorization await',async mode=>{
 const {s,grant,relay}=await paired(true)
 let finish!:(value:unknown)=>void; let wire!:NativeCommand
 // Capture precisely what dispatch actually transmitted, including its bounded deadline.
 relay.mockImplementation(async (path,_method,body)=>{if(path==='/command'){wire=body as NativeCommand;return new Promise(resolve=>{finish=resolve})}return {}})
 const dispatch=s.dispatch(scope,{protocol:grant.protocol,identity:grant.identity,grantId:grant.grantId,epoch:grant.epoch,commandId:'race',deadlineAt:Date.now()+30000,action:{kind:'observe',target:grant.targets[0]}})
 await vi.waitFor(()=>expect(wire).toBeDefined())
 const check={commandId:wire.commandId,grantId:wire.grantId,epoch:wire.epoch,deadlineAt:wire.deadlineAt,digest:createHash('sha256').update(JSON.stringify(wire)).digest('hex')}
 let release!:(value:unknown)=>void
 q.mockClear()
 q.mockImplementationOnce(() => new Promise(resolve => {release=resolve}) as never)
 q.mockResolvedValue({rows:[{}]} as never)
 const validation=s.revalidate('session','user','auth',check)
 expect(q).toHaveBeenCalledTimes(1)
 if(mode==='revoke') {
  // A foreign caller cannot delete the owner's pending authority.
  q.mockResolvedValueOnce({rows:[]} as never).mockResolvedValueOnce({rows:[]} as never)
  await expect(s.revoke('session','foreign')).rejects.toThrow()
  await s.revoke('session','user')
 } else vi.spyOn(Date,'now').mockReturnValue(wire.deadlineAt+1)
 release({rows:[{}]}); await expect(validation).rejects.toThrow()
 if(mode==='expiry') vi.mocked(Date.now).mockRestore()
 finish({commandId:wire.commandId,outcome:'not_executed',code:'denied'}); await dispatch
})
