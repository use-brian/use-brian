/** Owner-result decoding and token fencing; real locks/staleness use the native suite. [COMP:api/turn-lease] */
import {beforeEach,describe,expect,it,vi} from 'vitest'
vi.mock('../client.js',()=>({query:vi.fn()}))
import {query} from '../client.js'
import {claimTurnLease,claimTurnLeaseOutcome,captureTurnCancellation,touchTurnLease,releaseTurnLease,releaseTurnOutcome,
 reclaimStaleTurnOutcome,sweepStuckSessions,TURN_LEASE_STALE_AFTER_MS,TURN_HEARTBEAT_INTERVAL_MS} from '../sessions.js'
const token='10000000-0000-4000-8000-000000000001',turnId='a'.repeat(64),oldId='b'.repeat(64)
const mock=vi.mocked(query)
let answers:unknown[],candidates:unknown[]
beforeEach(()=>{answers=[];candidates=[];mock.mockReset();mock.mockImplementation(async(sql)=>{
 if(String(sql).includes('native_session_turn_transition(')||String(sql).includes('native_session_release_turn('))return{rows:[{value:answers.shift()??null}]} as never
 if(String(sql).includes('LIMIT 100'))return{rows:candidates} as never
 return{rows:[]} as never
})})
describe('[COMP:api/turn-lease] canonical owner protocol',()=>{
 it('retains private token compatibility while reporting the original recovered owner',async()=>{
  const recovered={turnId:oldId,reason:'publication_recovered'},observer=vi.fn()
  answers.push({state:'claimed',token,turnId,recovered})
  expect(await claimTurnLease('session','assistant',null,observer)).toBe(token)
  expect(observer).toHaveBeenCalledWith(recovered)
  expect(TURN_LEASE_STALE_AFTER_MS).toBeGreaterThanOrEqual(3*TURN_HEARTBEAT_INTERVAL_MS)
 })
 it('passes answering assistant and original request start to the single owner',async()=>{
  const started=new Date('2026-01-01T00:00:00Z');answers.push({state:'claimed',token,turnId,recovered:null})
  expect(await claimTurnLeaseOutcome('session','assistant',started)).toEqual({token,turnId})
  expect(mock.mock.calls[0][1]).toEqual(['session','claim','assistant',started,String(TURN_LEASE_STALE_AFTER_MS),null,null,false])
 })
 it('distinguishes busy/absent from malformed or unavailable owner results',async()=>{
  answers.push({state:'busy'},null,{state:'claimed',token,turnId:'invalid',recovered:null})
  expect(await claimTurnLeaseOutcome('session')).toBeNull();expect(await claimTurnLeaseOutcome('session')).toBeNull()
  await expect(claimTurnLeaseOutcome('session')).rejects.toThrow()
 })
 it('captures expected public identity as CAS while keeping the token private to the host',async()=>{
  answers.push({state:'cancel_requested',token,turnId,stale:false})
  expect(await captureTurnCancellation('session',turnId)).toEqual({state:'cancel_requested',token,turnId,stale:false})
  expect(mock.mock.calls[0][1]).toEqual(['session','cancel',null,null,String(TURN_LEASE_STALE_AFTER_MS),null,turnId,false])
 })
 it('distinguishes generic omission from an explicit tokenless owner expectation',async()=>{
  answers.push({state:'superseded'},{state:'cancel_requested',token,turnId,stale:false})
  expect(await captureTurnCancellation('session',null)).toEqual({state:'superseded'})
  expect(await captureTurnCancellation('session')).toMatchObject({state:'cancel_requested',token})
  expect(mock.mock.calls.filter(call=>String(call[0]).includes('native_session_turn_transition(')).map(call=>(call[1] as unknown[]).slice(5))).toEqual([[null,null,true],[null,null,false]])
 })
 it('uses the actual Stop result when a live holder requested completed',async()=>{
  answers.push({turnId,reason:'stopped_by_user'})
  expect(await releaseTurnOutcome('session','completed',token)).toEqual({turnId,reason:'stopped_by_user'})
  expect(mock.mock.calls[0][1]).toEqual(['session',token,'completed'])
 })
 it('rejects unfenced administrative release without executing SQL',async()=>{
  await expect(releaseTurnLease('session','stopped_by_user',null as unknown as string)).rejects.toThrow()
  expect(mock).not.toHaveBeenCalled()
 })
 it('does not allow the host to request a manufactured recovered outcome',async()=>{
  await expect(releaseTurnLease('session','publication_recovered',token)).rejects.toThrow()
  expect(mock).not.toHaveBeenCalled()
 })
 it('preserves a classifier unavailable failure instead of returning not-running',async()=>{
  mock.mockRejectedValueOnce(Object.assign(new Error('terminal_control_unavailable'),{code:'55000'}))
  await expect(reclaimStaleTurnOutcome('session')).rejects.toThrow('terminal_control_unavailable')
 })
 it('bounds sweep candidates and fences each original token, including NULL legacy identity',async()=>{
  candidates=[{id:'first',token,mode:null,userId:'user',visibility:'workspace',channelType:'web',anchorKind:'none'},
   {id:'legacy',token:null,mode:null,userId:'user',visibility:'workspace',channelType:'web',anchorKind:'none'}]
  answers.push({state:'recovered',recovered:{turnId,reason:'publication_recovered'}},{state:'busy'})
  const rows=await sweepStuckSessions(90000)
  expect(rows).toEqual([{id:'first',mode:null,userId:'user',visibility:'workspace',channelType:'web',anchorKind:'none',turnId,reason:'publication_recovered'}])
  const transitions=mock.mock.calls.filter(call=>String(call[0]).includes('native_session_turn_transition('))
  expect(transitions.map(call=>(call[1] as unknown[]).slice(5))).toEqual([[token,null,true],[null,null,true]])
  expect(JSON.stringify(rows)).not.toContain(token)
 })
 it.each([null,new Date()])('heartbeats report cancellation without changing request start: %s',async cancel=>{
  mock.mockResolvedValueOnce({rows:[{cancel_requested_at:cancel}]} as never)
  expect(await touchTurnLease('session',token)).toEqual({held:true,cancelRequested:cancel!==null})
  expect(String(mock.mock.calls[0][0])).not.toContain('turn_started_at')
 })
 it('a missing heartbeat row reports ownership loss',async()=>{
  expect(await touchTurnLease('session',token)).toEqual({held:false,cancelRequested:false})
 })
})
