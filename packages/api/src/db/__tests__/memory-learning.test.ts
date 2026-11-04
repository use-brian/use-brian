import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
vi.mock('../decision-event-store.js',()=>({appendDecisionEvent:vi.fn()}))
vi.mock('../decision-provenance-store.js',()=>({appendDecisionDerivation:vi.fn()}))
import { prepareMemoryLearning } from '../memory-learning.js'
import { appendDecisionEvent } from '../decision-event-store.js'
const w='00000000-0000-4000-8000-000000000001', u='00000000-0000-4000-8000-000000000002'
const base={assistantId:w,userId:u,createdByUserId:u,summary:'Prefers short status updates',sensitivity:'internal' as const}
const observation={userId:u,sessionId:w,messageId:u,text:'I prefer short status updates.'}
const proposal={intent:'explicit' as const,kind:'preference' as const,quote:observation.text,applicability:{activity:'status_update' as const}}
function client(rows: (sql:string)=>unknown[]) {
 return {query:vi.fn(async(sql:string)=>({rows:rows(sql)}))} as unknown as pg.PoolClient
}
beforeEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()})
describe('[COMP:memory/learning] canonical admission',()=>{
 it('leaves existing writers unassessed when admission is disabled',async()=>{
  vi.stubEnv('BRIAN_MEMORY_LEARNING_V1','0')
  expect(await prepareMemoryLearning(client(()=>[]),base,w)).toEqual({learning:null})
 })
 it('requires an actual current human source before admitting explicit intent',async()=>{
  vi.stubEnv('BRIAN_MEMORY_LEARNING_V1','1')
  await expect(prepareMemoryLearning(client(()=>[]),{...base,observation,sourceSessionId:w,learningProposal:proposal},w)).rejects.toThrow('memory_source_mismatch')
  expect(appendDecisionEvent).not.toHaveBeenCalled()
 })
 it('records grounded explicit intent with a durable decision receipt',async()=>{
  vi.stubEnv('BRIAN_MEMORY_LEARNING_V1','1')
  vi.mocked(appendDecisionEvent).mockResolvedValue({event:{id:u} as never,inserted:true})
  const db=client(sql=>sql.includes('SELECT m.content')?[{content:observation.text,actor:u,held:false}]:[])
  const result=await prepareMemoryLearning(db,{...base,observation,sourceSessionId:w,learningProposal:proposal},w)
  expect(result.learning).toMatchObject({state:'established',applicability:{activity:'status_update'}})
  expect(result.eventId).toBe(u)
  expect(appendDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({eventKind:'memory.observation_recorded',actorUserId:u,sourceId:u}),db)
 })
 it('does not replay a previously forgotten observation as a new memory',async()=>{
  vi.stubEnv('BRIAN_MEMORY_LEARNING_V1','1')
  vi.mocked(appendDecisionEvent).mockResolvedValue({event:{id:u} as never,inserted:false})
  const db=client(sql=>sql.includes('SELECT m.content')?[{content:observation.text,actor:u,held:false}]:[])
  await expect(prepareMemoryLearning(db,{...base,observation,sourceSessionId:w,learningProposal:proposal},w)).rejects.toThrow('memory_evidence_replayed')
 })
})
