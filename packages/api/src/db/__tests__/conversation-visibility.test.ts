/** [COMP:api/conversation-visibility] Unmounted settings boundary rejects unsafe
 * commands and distinguishes authoritative denial/conflict from availability. */
import {beforeEach,describe,expect,it,vi} from 'vitest'
const queryWithRLS=vi.hoisted(()=>vi.fn())
vi.mock('../client.js',()=>({queryWithRLS}))
import {changeConversationVisibility,readConversationVisibility,conversationVisibilityMutationSchema,
  type ConversationVisibilityActor} from '../conversation-visibility.js'
const actor:ConversationVisibilityActor={userId:'11111111-1111-4111-8111-111111111111',
 authSessionId:'22222222-2222-4222-8222-222222222222',authVersion:1}
const session='33333333-3333-4333-8333-333333333333'
beforeEach(()=>queryWithRLS.mockReset())
describe('[COMP:api/conversation-visibility] settings boundary',()=>{
 it('rejects requests to remove private-by-kind, unchecked versions, duplicate participants and unowned fields',()=>{
  for(const input of [
   {expectedVersion:1,visibility:'private_by_kind'},
   {expectedVersion:0,visibility:'workspace'},
   {expectedVersion:Number.MAX_SAFE_INTEGER+1,visibility:'workspace'},
   {expectedVersion:1,visibility:'configured_private',participantUserIds:[actor.userId,actor.userId]},
   {expectedVersion:1,visibility:'workspace',conversationCap:'public'},
  ])expect(conversationVisibilityMutationSchema.safeParse(input).success).toBe(false)
  expect(queryWithRLS).not.toHaveBeenCalled()
 })
 it('surfaces an authoritative denial and a conflict with distinct typed status',async()=>{
  queryWithRLS.mockRejectedValueOnce({code:'42501',message:'conversation_access_denied'})
  await expect(readConversationVisibility(actor,session)).rejects.toMatchObject({code:'conversation_access_denied',status:403})
  queryWithRLS.mockRejectedValueOnce({code:'P0001',message:'conversation_visibility_conflict'})
  await expect(changeConversationVisibility(actor,session,{expectedVersion:1,visibility:'workspace'}))
   .rejects.toMatchObject({code:'conversation_visibility_conflict',status:409})
 })
 it('does not turn schema/transport failure into an empty or inaccessible session',async()=>{
  const unavailable=new Error('fixture unavailable')
  queryWithRLS.mockRejectedValueOnce(unavailable)
  await expect(readConversationVisibility(actor,session)).rejects.toBe(unavailable)
  queryWithRLS.mockResolvedValueOnce({rows:[{value:{}}]})
  await expect(readConversationVisibility(actor,session)).rejects.toThrow()
  queryWithRLS.mockResolvedValueOnce({rows:[]})
  await expect(readConversationVisibility(actor,session)).rejects.toThrow('conversation_visibility_unavailable')
 })
})
