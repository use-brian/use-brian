import {beforeEach,describe,expect,it,vi} from 'vitest'
import express from 'express'
import request from 'supertest'
const mocks=vi.hoisted(()=>({inspect:vi.fn(),recover:vi.fn()}))
vi.mock('../../db/session-recovery.js',async original=>({...await original<typeof import('../../db/session-recovery.js')>(),inspectSessionRecovery:mocks.inspect,recoverSession:mocks.recover}))
import {sessionRecoveryRoutes} from '../session-recovery.js'
import {WorkspaceAccessError} from '../../workspace-access/policy.js'
const source='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222'
const actor='33333333-3333-4333-8333-333333333333',device='44444444-4444-4444-8444-444444444444',revision='a'.repeat(64)
function app(authenticated=true){
 const result=express();result.use(express.json())
 result.use((req,_res,next)=>{if(authenticated)Object.assign(req,{userId:actor,authSessionId:device,authVersion:2});next()})
 result.use('/sessions/:id/recovery',sessionRecoveryRoutes());return result
}
beforeEach(()=>{vi.resetAllMocks();mocks.inspect.mockResolvedValue({status:'available'});mocks.recover.mockResolvedValue({sessionId:'new'})})
describe('[COMP:api/session-recovery] native HTTP recovery commands',()=>{
 it('uses only verified middleware identity and disables response caching',async()=>{
  const response=await request(app()).get(`/sessions/${source}/recovery?workspaceId=${workspace}`).expect(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(mocks.inspect).toHaveBeenCalledWith({sessionId:source,workspaceId:workspace,claims:{userId:actor,sessionId:device,authVersion:2}})
  await request(app()).post(`/sessions/${source}/recovery`).send({workspaceId:workspace,expectedRevision:revision}).expect(200)
  expect(mocks.recover).toHaveBeenCalledWith({sessionId:source,workspaceId:workspace,expectedRevision:revision,claims:{userId:actor,sessionId:device,authVersion:2}})
 })
 it('rejects unsigned identity, malformed IDs and forged extra command fields before service admission',async()=>{
  await request(app(false)).get(`/sessions/${source}/recovery?workspaceId=${workspace}`).expect(401)
  await request(app()).get(`/sessions/not-a-session/recovery?workspaceId=${workspace}`).expect(404)
  for(const body of [{workspaceId:workspace},{workspaceId:workspace,expectedRevision:revision,userId:actor},{workspaceId:'foreign',expectedRevision:revision}]){
   await request(app()).post(`/sessions/${source}/recovery`).send(body).expect(400)
  }
  expect(mocks.inspect).not.toHaveBeenCalled();expect(mocks.recover).not.toHaveBeenCalled()
 })
 it.each([['session_recovery_changed',409],['session_recovery_busy',409],['session_recovery_unavailable',404]] as const)('preserves typed refusal %s',async(code,status)=>{
  mocks.recover.mockRejectedValue(new WorkspaceAccessError(code,status))
  await request(app()).post(`/sessions/${source}/recovery`).send({workspaceId:workspace,expectedRevision:revision}).expect(status,{error:code})
 })
})
