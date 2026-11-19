/** [COMP:api/conversation-visibility] Strict model-capture receiving boundary. */
import {randomUUID} from 'node:crypto'
import {describe,expect,it} from 'vitest'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {parseConversationRecord} from '../conversation-record.js'

function fixture(){
 const selection={workspaceId:randomUUID(),sessionId:randomUUID(),afterSequence:0,throughSequence:2,topicThroughSequence:2}
 const raw={source:{workspaceId:selection.workspaceId,userId:null,assistantId:null,resourceKind:'conversation_record',resourceId:randomUUID(),
  version:'1',sensitivity:'internal',compartments:[],projectIds:[]},generation:'1',dataRevision:'1',
  rows:[1,2].map(sequenceNum=>({id:randomUUID(),sessionId:selection.sessionId,role:sequenceNum===1?'user':'assistant',
   sequenceNum,content:[{type:'text',text:'Fictional dialogue'}],createdAt:'2026-11-17T00:00:00.000Z',
   senderUserId:null,senderAssistantId:null,channelMessageId:null,attachments:[]})),annotations:[],
  manifest:{afterSequence:0,throughSequence:2,topicThroughSequence:2,modelRecipe:'dialogue_text_v1',
   rowCount:2,annotationCount:0,payloadDigest:'a'.repeat(64),rowIdentityDigest:'b'.repeat(64),annotationIdentityDigest:'c'.repeat(64)}}
 return{selection,raw}
}
describe('[COMP:api/conversation-visibility] immutable dialogue parser',()=>{
 it('returns only deterministic dialogue with one source bound to the collection and every row',()=>{
  const {selection,raw}=fixture()
  const value=parseConversationRecord(raw,selection)
  expect(value.rows).toHaveLength(2)
  expect(boundScopeSources(value.rows)).toEqual([value.source])
  for(const row of value.rows)expect(boundScopeSources(row)).toEqual([value.source])
 })
 it('refuses substituted source/workspace, model recipe, selector or count rather than returning empty history',()=>{
  for(const mutate of [
   (raw:ReturnType<typeof fixture>['raw'])=>{raw.source.workspaceId=randomUUID()},
   (raw:ReturnType<typeof fixture>['raw'])=>{raw.manifest.modelRecipe='raw_tool_bodies'},
   (raw:ReturnType<typeof fixture>['raw'])=>{raw.manifest.throughSequence=3},
   (raw:ReturnType<typeof fixture>['raw'])=>{raw.manifest.rowCount=0},
  ]){
   const {selection,raw}=fixture();mutate(raw)
   expect(()=>parseConversationRecord(raw,selection)).toThrow()
  }
 })
 it('refuses duplicate, unordered and cross-session rows despite a well-shaped source',()=>{
  for(const mutate of [
   (raw:ReturnType<typeof fixture>['raw'])=>{raw.rows[1].id=raw.rows[0].id},
   (raw:ReturnType<typeof fixture>['raw'])=>{raw.rows.reverse()},
   (raw:ReturnType<typeof fixture>['raw'])=>{raw.rows[1].sessionId=randomUUID()},
  ]){
   const {selection,raw}=fixture();mutate(raw)
   expect(()=>parseConversationRecord(raw,selection)).toThrow()
  }
 })
 it('keeps attachment identity while dropping file bodies, host observations and tool-bearing replies',()=>{
  const {selection,raw}=fixture()
  raw.rows[0].content=[{type:'text',text:'Read <attached_file id="fixture-file" name="notes.txt" type="text/plain">FILE_SECRET</attached_file>'}]
  raw.rows[1].content=[{type:'tool_use',id:'fictional-tool',name:'read_file',input:{}},{type:'text',text:'TOOL_SECRET'}] as never
  const value=parseConversationRecord(raw,selection),wire=JSON.stringify(value.rows)
  expect(value.rows).toHaveLength(1);expect(wire).toContain('[Attached file:')
  expect(wire).not.toContain('FILE_SECRET');expect(wire).not.toContain('TOOL_SECRET')
 })
})
