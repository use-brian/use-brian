/** [COMP:api/conversation-visibility] Source stamps cannot flatten a private
 * participant audience into a workspace output. SQL writer tests are separately
 * required before this structural contract activates. */
import { describe, expect, it } from 'vitest'
import { conversationAudienceContainsDestination, type ConversationAudience } from '../conversation-audience.js'
const source: ConversationAudience = { sessionId:'conversation-a',workspaceId:'workspace-a',starterUserId:'member-a',
  visibility:'configured_private',participantUserIds:['member-b'],cap:'internal',compartments:['team:department-a'],
  projectIds:['project-a'],anchor:null,generation:'7' }
const destination = (overrides: Partial<ConversationAudience> = {}) => ({ kind:'conversation' as const,
  audience:{...source,sessionId:'conversation-b',...overrides} })
describe('[COMP:api/conversation-visibility] conversation record destination containment',()=>{
 it('permits the same record generation and a narrower private participant set',()=>{
  expect(conversationAudienceContainsDestination(source,{kind:'conversation',audience:source})).toEqual({allowed:true})
  expect(conversationAudienceContainsDestination(source,destination({participantUserIds:[]}))).toEqual({allowed:true})
 })
 it('refuses a broader room and a different private participant set, even with identical unowned stamps',()=>{
  expect(conversationAudienceContainsDestination(source,destination({visibility:'workspace'}))).toEqual({allowed:false,reason:'participants'})
  expect(conversationAudienceContainsDestination(source,destination({participantUserIds:['member-c']}))).toEqual({allowed:false,reason:'participants'})
 })
 it('permits an admitted participant own-private derivative while retaining the source edge',()=>{
  const scope={workspaceId:source.workspaceId,userId:'member-b',assistantId:null,sensitivity:source.cap,
   compartments:[...source.compartments],projectIds:[...source.projectIds]}
  expect(conversationAudienceContainsDestination(source,{kind:'resource',scope})).toEqual({allowed:true})
  expect(conversationAudienceContainsDestination(source,{kind:'resource',scope:{...scope,userId:null}})).toEqual({allowed:false,reason:'participants'})
  expect(conversationAudienceContainsDestination(source,{kind:'resource',scope:{...scope,userId:'member-c'}})).toEqual({allowed:false,reason:'participants'})
 })
 it('does not add participants to a private-by-kind source or accept an old generation',()=>{
  expect(conversationAudienceContainsDestination({...source,visibility:'private_by_kind'},destination())).toEqual({allowed:false,reason:'participants'})
  expect(conversationAudienceContainsDestination(source,{kind:'conversation',audience:{...source,generation:'8'}})).toEqual({allowed:false,reason:'generation'})
 })
 it('cannot turn a permanent 1:1 boundary into an administrator-widenable copy with the same sole reader',()=>{
  const direct={...source,visibility:'private_by_kind' as const,participantUserIds:[]}
  expect(conversationAudienceContainsDestination(direct,destination({participantUserIds:[]}))).toEqual({allowed:false,reason:'participants'})
  expect(conversationAudienceContainsDestination(direct,destination({visibility:'private_by_kind',participantUserIds:[]}))).toEqual({allowed:true})
 })
 it('retains source cap and all Department/Project boundaries, and never crosses a workspace',()=>{
  for(const patch of [{cap:'public' as const},{compartments:[]},{projectIds:[]}])
   expect(conversationAudienceContainsDestination(source,destination(patch))).toEqual({allowed:false,reason:'labels'})
  expect(conversationAudienceContainsDestination(source,destination({workspaceId:'workspace-b'}))).toEqual({allowed:false,reason:'workspace'})
  expect(conversationAudienceContainsDestination(source,destination({cap:'confidential',compartments:[...source.compartments,'team:department-b']}))).toEqual({allowed:true})
 })
 it('does not confuse different anchor audiences',()=>{
  const anchored={...source,visibility:'workspace' as const,anchor:{kind:'doc_thread',id:'anchor-a'}}
  expect(conversationAudienceContainsDestination(anchored,destination({visibility:'workspace'}))).toEqual({allowed:false,reason:'anchor'})
  expect(conversationAudienceContainsDestination(anchored,destination({visibility:'workspace',anchor:{kind:'doc_thread',id:'anchor-b'}}))).toEqual({allowed:false,reason:'anchor'})
  expect(conversationAudienceContainsDestination(anchored,destination({visibility:'workspace',anchor:anchored.anchor}))).toEqual({allowed:true})
 })
 it('requires fresh source authority for the actual personal recipient, consistently for a conversation and resource',()=>{
  const anchored={...source,visibility:'workspace' as const,anchor:{kind:'doc_thread',id:'anchor-a'}}
  const personal=destination({visibility:'private_by_kind',starterUserId:'member-b',participantUserIds:[],anchor:null})
  const resource={kind:'resource' as const,scope:{workspaceId:source.workspaceId,userId:'member-b',assistantId:null,
    sensitivity:source.cap,compartments:[...source.compartments],projectIds:[...source.projectIds]}}
  const actorA={sourceSessionId:source.sessionId,sourceGeneration:source.generation,readerUserId:'member-a'}
  const recipientB={...actorA,readerUserId:'member-b'}
  for(const target of [personal,resource]) {
    // Member A still has Page access. B's revocation cannot be laundered by A.
    expect(conversationAudienceContainsDestination(anchored,target,actorA)).toEqual({allowed:false,reason:'anchor'})
    expect(conversationAudienceContainsDestination(anchored,target)).toEqual({allowed:false,reason:'anchor'})
    expect(conversationAudienceContainsDestination(anchored,target,recipientB)).toEqual({allowed:true})
    expect(conversationAudienceContainsDestination(anchored,target,{...recipientB,sourceGeneration:'6'})).toEqual({allowed:false,reason:'generation'})
  }
 })
 it('refuses the whole mixed-source write when any private audience is not contained',()=>{
  const mixed=[source,{...source,starterUserId:'member-c',participantUserIds:[]}]
  expect(mixed.every(value=>conversationAudienceContainsDestination(value,destination()).allowed)).toBe(false)
 })
})
