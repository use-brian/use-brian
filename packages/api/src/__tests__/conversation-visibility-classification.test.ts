/** [COMP:api/conversation-visibility] Privacy kind cannot weaken after archive,
 * member removal or transport changes; SQL mirror is exercised by the migration
 * suite against the same canonical classification. */
import {describe,expect,it} from 'vitest'
import {classifyConversationVisibility,type SessionKindRow} from '../session-kind.js'
const row:SessionKindRow={visibility:'personal',channelType:'web',channelId:'fictional',anchorKind:'none',appOrigin:'chat'}
describe('[COMP:api/conversation-visibility] no-widen classification',()=>{
 it.each(['web','telegram','slack','discord','whatsapp','feishu','msteams','wechat','imessage','custom'])('keeps member direct %s private without current membership evidence',channelType=>{
  expect(classifyConversationVisibility({...row,channelType},{historical:true,workspace:true})).toBe('private_by_kind')
  expect(classifyConversationVisibility({...row,channelType,anchorKind:'channel'},{historical:true,workspace:true})).toBe('private_by_kind')
 })
 it('keeps the personal doc dock distinct from a shared anchored thread',()=>{
  expect(classifyConversationVisibility({...row,appOrigin:'doc'},{historical:true,workspace:true})).toBe('private_by_kind')
  expect(classifyConversationVisibility({...row,visibility:'workspace',anchorKind:'doc_thread'},{historical:true,workspace:true})).toBe('workspace')
 })
 it('requires positive same-conversation room evidence before a retained group is configured-private',()=>{
  expect(classifyConversationVisibility({...row,channelType:'slack'},{historical:true,workspace:true,provenLegacyGroup:true})).toBe('configured_private')
 })
 it.each([true,false])('existing guest and public lanes retain their readership (workspace=%s)',workspace=>{
  expect(classifyConversationVisibility({...row,guestSessionToken:'fictional'},{historical:true,workspace})).toBe('configured_private')
  expect(classifyConversationVisibility({...row,channelType:'api'},{historical:true,workspace})).toBe('configured_private')
 })
 it('new guest and public API lanes use workspace default even without a guest token',()=>{
  expect(classifyConversationVisibility({...row,guestSessionToken:'fictional'},{historical:false,workspace:true})).toBe('workspace')
  expect(classifyConversationVisibility({...row,channelType:'api'},{historical:false,workspace:true})).toBe('workspace')
  expect(classifyConversationVisibility({...row,channelType:'api'},{historical:false,workspace:true,currentMember:true})).toBe('private_by_kind')
  expect(classifyConversationVisibility({...row,channelType:'telegram'},{historical:false,workspace:true,currentMember:false})).toBe('workspace')
  expect(classifyConversationVisibility({...row,channelType:'telegram'},{historical:true,workspace:true,currentMember:false})).toBe('private_by_kind')
 })
 it('uses normalized persisted shapes, including transient sessions, with no legacy descriptor fallback',()=>{
  expect(classifyConversationVisibility({...row,transient:true},{historical:true,workspace:true})).toBe('configured_private')
  expect(()=>classifyConversationVisibility({...row,anchorKind:null,mode:'draft'},{historical:true,workspace:true})).toThrow('conversation_kind_not_normalized')
  expect(classifyConversationVisibility({...row,mode:'draft'},{historical:true,workspace:true})).toBe('private_by_kind')
 })
 it('never manufactures workspace sharing on a personal assistant',()=>{
  expect(classifyConversationVisibility({...row,channelType:'api'},{historical:false,workspace:false})).toBe('configured_private')
 })
})
