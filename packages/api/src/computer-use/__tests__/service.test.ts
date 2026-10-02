import { it,expect,vi,beforeEach } from 'vitest'
vi.mock('../../db/client.js',()=>({query:vi.fn()}))
import { query } from '../../db/client.js'
import { NativeComputerService } from '../service.js'
import type { NativeGrant, NativeCommand } from '@use-brian/computer-control/protocol.js'
import { composeNativeComputerTool } from '../composition.js'
import type { ToolContext } from '@use-brian/core'
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
 const { s, grant } = await paired(true); vi.spyOn(s,'assertCurrent').mockResolvedValue()
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
