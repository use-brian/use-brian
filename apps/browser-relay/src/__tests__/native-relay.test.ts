import { describe,it,expect,vi,afterEach } from 'vitest'
import { NativeRelay } from '../native-relay.js'
import { NATIVE_PROTOCOL, type NativeGrant, type NativeCommand } from '@use-brian/computer-control/protocol.js'
const identity={deploymentId:'deployment',userId:'user',workspaceId:'workspace',deviceId:'device',sessionId:'session',conversationId:'conversation',taskId:'task'}
const target={appId:'app',processId:1,processInstanceId:'p1',windowId:'w',windowInstanceId:'w1'}
function fixture(){
 const grant: NativeGrant={protocol:NATIVE_PROTOCOL,identity,grantId:'grant',epoch:0,expiresAt:Date.now()+60_000,targets:[target],allowControl:false,allowCapture:false,requester:'user',goal:'inspect'}
 const claims={aud:NATIVE_PROTOCOL,kind:'native-session' as const,identity,grantId:'grant',epoch:0,exp:grant.expiresAt,jti:'jti'}
 const relay=new NativeRelay(token=>token==='native'?claims:null)
 const socket={send:vi.fn(),close:vi.fn()}
 relay.register(grant,'jti')
 const hello=()=>relay.handle(socket,JSON.stringify({type:'hello',protocol:NATIVE_PROTOCOL,token:'native'}))
 const command:NativeCommand={protocol:NATIVE_PROTOCOL,identity,grantId:'grant',epoch:0,commandId:'cmd',deadlineAt:Date.now()+1000,action:{kind:'observe',target}}
 return {relay,socket,hello,command,grant}
}
afterEach(()=>vi.useRealTimers())
describe('native relay isolation',()=>{
 it('rejects browser credentials and nonhello',()=>{const f=fixture(); f.relay.handle(f.socket,JSON.stringify({type:'hello',protocol:NATIVE_PROTOCOL,token:'browser'}));expect(f.socket.close).toHaveBeenCalled();expect(f.relay.status('session').connected).toBe(false)})
 it('never steals a device lease',()=>{const f=fixture();expect(()=>f.relay.register({...f.grant,identity:{...identity,sessionId:'other'}},'other')).toThrow('Device busy')})
 it('fences epoch, scope, deadline and ungranted input',async()=>{const f=fixture();f.hello();for(const c of [{...f.command,epoch:1},{...f.command,identity:{...identity,workspaceId:'other'}},{...f.command,deadlineAt:Date.now()+31_000},{...f.command,action:{kind:'invoke' as const,target,observationId:'o',ref:'r'}}])expect((await f.relay.dispatch(c)).outcome).toBe('not_executed')})
 it('correlates receipt and refuses replay',async()=>{const f=fixture();f.hello();const pending=f.relay.dispatch(f.command);f.relay.handle(f.socket,JSON.stringify({type:'receipt',receipt:{commandId:'cmd',outcome:'executed',code:'ok'}}));expect((await pending).outcome).toBe('executed');expect((await f.relay.dispatch(f.command)).outcome).toBe('not_executed')})
 it('wrong correlation revokes and marks dispatched effect unknown',async()=>{const f=fixture();f.hello();const pending=f.relay.dispatch(f.command);f.relay.handle(f.socket,JSON.stringify({type:'receipt',receipt:{commandId:'wrong',outcome:'executed',code:'ok'}}));expect((await pending).outcome).toBe('execution_unknown');expect(f.relay.status('session').active).toBe(false)})
 it('disconnect invalidates old token; no automatic reconnect',()=>{const f=fixture();f.hello();f.relay.disconnect(f.socket);f.hello();expect(f.relay.status('session').active).toBe(false);expect(f.socket.close).toHaveBeenCalled()})
 it('heartbeat expiry and command timeout revoke',async()=>{vi.useFakeTimers();const f=fixture();f.hello();const pending=f.relay.dispatch(f.command);await vi.advanceTimersByTimeAsync(1001);expect((await pending).outcome).toBe('execution_unknown');const g=fixture();g.hello();await vi.advanceTimersByTimeAsync(30_001);g.relay.sweep();expect(g.relay.status('session').active).toBe(false)})
})
