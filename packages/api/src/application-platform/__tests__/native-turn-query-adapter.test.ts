/** [COMP:api/native-turn-frame] The conversation acquisition port has no fallback. */
import {describe,expect,it,vi} from 'vitest'
import pg, {type PoolClient} from 'pg'
import {captureConversationQuery,captureSessionTopics,ConversationHistoryUnavailableError} from '../../db/conversation-store.js'
const workspaceId='00000000-0000-4000-8000-000000000101'
const selection={sessionId:'00000000-0000-4000-8000-000000000102',throughSequence:3,topicThroughSequence:2}
const source={workspaceId,userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[],
 resourceKind:'application_field',resourceId:'00000000-0000-4000-8000-000000000103',version:'fictional-version'}
const packet={history:[{row:null,sources:[source]}],annotations:[{row:null,sources:[source]}]}
const sql='SELECT capture_conversation_query($1,$2,$3,$4) AS value'
const args=[workspaceId,selection.sessionId,3,2]
function connection(value:unknown){
 const query=vi.fn(async()=>{if(value instanceof Error)throw value;return{rows:[{value}]}})
 return{query,client:{query} as unknown as Pick<PoolClient,'query'>}
}
describe('[COMP:api/native-turn-frame] canonical conversation capture',()=>{
 it('acquires both selections with only identity arguments',async()=>{
  const f=connection(packet);expect(await captureConversationQuery(f.client,workspaceId,selection)).toEqual(packet)
  expect(f.query.mock.calls).toEqual([[sql,args]])
 })
 it.each([null,undefined,{...packet,history:[]},{...packet,proof:{admitted:true}},
  {...packet,history:[{row:null,sources:[{...source,workspaceId:selection.sessionId}]}]},
  {...packet,history:[{row:null,sources:[{...source,resourceKind:'recording'}]}]},
 ])('rejects unavailable or malformed data without another reader',async value=>{
  const f=connection(value);await expect(captureConversationQuery(f.client,workspaceId,selection)).rejects.toThrow()
  expect(f.query).toHaveBeenCalledTimes(1)
 })
 it('propagates the original post-write refusal without retry',async()=>{
  const refusal=Object.assign(new Error('scope_source_changed'),{code:'42501'}),f=connection(refusal)
  await expect(captureConversationQuery(f.client,workspaceId,selection)).rejects.toBe(refusal)
  expect(f.query).toHaveBeenCalledTimes(1)
 })
 it.each([
  ['full', (client:Pick<PoolClient,'query'>)=>captureConversationQuery(client,workspaceId,selection)],
  ['topic-only', (client:Pick<PoolClient,'query'>)=>captureSessionTopics(client,workspaceId,selection.sessionId,selection.topicThroughSequence)],
 ] as const)('types the %s ancestry refusal only when the PostgreSQL driver produced it',async(_kind,read)=>{
  const diagnostic={code:'42501',routine:'exec_stmt_raise'}
  const imitation=Object.assign(new Error('scope_ancestry_unavailable'),diagnostic)
  const refusal=Object.assign(new pg.DatabaseError('scope_ancestry_unavailable',0,'error'),diagnostic)
  await expect(read(connection(imitation).client)).rejects.toBe(imitation)
  const captured=read(connection(refusal).client)
  await expect(captured).rejects.toBeInstanceOf(ConversationHistoryUnavailableError)
  await expect(captured).rejects.toHaveProperty('cause',refusal)
 })
})
