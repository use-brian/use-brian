/** [COMP:api/turn-lease] Actual concurrent claim, stale recovery and successor fences. */
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import {getAppPool,getPool} from '../client.js'
import {claimTurnLease,releaseTurnLease,requestTurnCancel,touchTurnLease} from '../sessions.js'
import {takeTurnLease} from '../../turn/lease.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
afterAll(async()=>{await getAppPool().end();await getPool().end()})
describe.sequential('[COMP:api/turn-lease] atomic owner acquisition',()=>{
 it.each(['personal','room'] as const)('admits exactly one of eight simultaneous %s claimers',async admission=>{
  fixture=await persistentContextFixture();const f=fixture
  const slots=await Promise.all(Array.from({length:8},()=>takeTurnLease({sessionId:f.session.id,admission,assistantId:f.assistantId})))
  const accepted=slots.filter(slot=>slot.taken)
  expect(accepted).toHaveLength(1)
  expect(slots.filter(slot=>!slot.taken)).toHaveLength(7)
  const row=(await f.pool.query('SELECT status,turn_lease_token,turn_assistant_id,turn_heartbeat_at FROM sessions WHERE id=$1',[f.session.id])).rows[0]
  expect(row).toMatchObject({status:'running',turn_lease_token:accepted[0].token,turn_assistant_id:f.assistantId})
  expect(row.turn_heartbeat_at).not.toBeNull()
 })
 it('reclaims a stale owner atomically, preserving original request time and excluding old heartbeats/releases',async()=>{
  fixture=await persistentContextFixture();const f=fixture,old=await claimTurnLease(f.session.id)
  expect(old).toBeTruthy();await requestTurnCancel(f.session.id)
  await f.pool.query("UPDATE sessions SET turn_heartbeat_at=now()-interval '2 minutes' WHERE id=$1",[f.session.id])
  const startedAt=new Date('2026-01-01T00:00:00Z'),recovered=vi.fn()
  const next=await claimTurnLease(f.session.id,f.assistantId,startedAt,recovered)
  expect(recovered).toHaveBeenCalledTimes(1)
  expect(recovered).toHaveBeenCalledWith({turnId:expect.stringMatching(/^[a-f0-9]{64}$/),reason:'stopped_by_user'})
  expect(next).toBeTruthy();expect(next).not.toBe(old)
  expect(await touchTurnLease(f.session.id,old!)).toEqual({held:false,cancelRequested:false})
  expect(await releaseTurnLease(f.session.id,'completed',old!)).toBe(false)
  expect((await f.pool.query('SELECT status,turn_started_at,cancel_requested_at FROM sessions WHERE id=$1',[f.session.id])).rows[0])
   .toEqual({status:'running',turn_started_at:startedAt,cancel_requested_at:null})
 })
 it('preserves live Stop intent against a competing claim',async()=>{
  fixture=await persistentContextFixture();const f=fixture,token=await claimTurnLease(f.session.id)
  expect(token).toBeTruthy();expect(await requestTurnCancel(f.session.id)).toBe(true)
  expect(await claimTurnLease(f.session.id)).toBeNull()
  expect(await touchTurnLease(f.session.id,token!)).toEqual({held:true,cancelRequested:true})
 })
 it.each([false,true])('recovers a tokenless legacy row only when stale: %s',async stale=>{
  fixture=await persistentContextFixture();const f=fixture
  await f.pool.query(`UPDATE sessions SET status='running',turn_lease_token=NULL,turn_heartbeat_at=NULL,
   last_active_at=now()-($2::int*interval '1 second') WHERE id=$1`,[f.session.id,stale?120:0])
  expect(Boolean(await claimTurnLease(f.session.id))).toBe(stale)
 })
 it('reclaims only after a waiting caller reacquires the actual database slot',async()=>{
  fixture=await persistentContextFixture();const f=fixture,old=await claimTurnLease(f.session.id)
  let waits=0
  const slot=await takeTurnLease({sessionId:f.session.id,admission:'personal',waitForSlot:async id=>{
   waits++;expect(id).toBe(f.session.id);expect(await releaseTurnLease(id,'completed',old!)).toBe(true);return true
  }})
  expect(waits).toBe(1);expect(slot.taken).toBe(true)
  if(slot.taken)expect(slot.token).not.toBe(old)
 })
})
