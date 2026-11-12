import {beforeEach,describe,expect,it,vi} from 'vitest'
import {bindScopeSources,boundScopeSources,ContextScopeAccumulator,type LLMProvider,type SessionContextAuthority} from '@use-brian/core'
import type {Session,SessionMessage} from '../../db/sessions.js'
import {assessAttendedSessionMessage,topicEvidenceFromHistory} from '../attended-session-context.js'

const spies=vi.hoisted(()=>({query:vi.fn(),proof:vi.fn(),classify:vi.fn(),sql:vi.fn(),prepare:vi.fn()}))
vi.mock('@use-brian/core',async original=>({...await original<typeof import('@use-brian/core')>(),classifyTopic:spies.classify,
 executionToolContext:(execution:unknown,base:object)=>({...base,executionContext:execution})}))
vi.mock('../../db/client.js',async original=>({...await original<typeof import('../../db/client.js')>(),getPool:()=>({query:spies.sql})}))
vi.mock('../../db/session-query-reader.js',()=>({readAdmittedSessionQuery:spies.query,captureSessionTopics:vi.fn(),sessionQueryRootMetadata:vi.fn()}))
vi.mock('../../db/session-context-revisions.js',()=>({readSessionQueryFrame:vi.fn()}))
vi.mock('../../db/session-message-annotations.js',()=>({prepareSessionMessageAnnotation:spies.prepare,writeSessionMessageAnnotation:vi.fn()}))
vi.mock('../../application-platform/model-source-authority.js',()=>({assertSourceModelInputAuthority:spies.proof,ownsNativeAttendedAssembly:vi.fn()}))

beforeEach(()=>{
 vi.clearAllMocks()
 spies.sql.mockResolvedValue({rows:[]})
 spies.proof.mockResolvedValue(undefined)
 spies.classify.mockImplementation(async options=>{
  await options.assertInputAuthority()
  return {topic_label:'topic:v2:'+'a'.repeat(64),state:'shift',confidence:0.9,related_topics:[],usage:null}
 })
})
function fixture(){
 const authority={execution:{security:{authority:{assertCurrent:vi.fn().mockResolvedValue(undefined)},access:{workspaceId:'workspace-fixture'}}},accumulator:new ContextScopeAccumulator()} as unknown as SessionContextAuthority
 const session={id:'session-fixture'} as Session
 const oldText='Full old anchor '+ 'evidence '.repeat(1000)
 const history=[{id:'old',role:'user',content:[{type:'text',text:oldText}]},{id:'answer',role:'assistant',content:'Full assistant context'},
  ...Array.from({length:25},(_,i)=>({id:'turn-'+i,role:'user',content:'New subject '+i})),
  {id:'return',role:'user',content:'Back to original'}, {id:'current',role:'user',content:'A substantial new request for the classifier'}]
  .map((row,i)=>({...row,sequenceNum:i+1,sessionId:session.id})) as SessionMessage[]
 const annotations=[{id:'old',topicLabel:'legacy subject'},...Array.from({length:25},(_,i)=>({id:'turn-'+i,topicLabel:'subject-'+i})),{id:'return',topicLabel:'legacy subject'}]
 const source={workspaceId:'workspace-fixture',userId:'user-fixture',assistantId:null,sensitivity:'public' as const,compartments:[],projectIds:[],resourceKind:'session_message',resourceId:'old',version:'1'}
 const annotationSource={...source,resourceKind:'session_message_annotation',resourceId:'old-annotation'}
 spies.query.mockResolvedValue(bindScopeSources({history,annotations},[source,annotationSource]))
 const input={authority,session,message:history.at(-1)!,provider:{name:'fixture'} as LLMProvider,model:'fixture'}
 return {input,oldText,source,annotationSource}
}
describe('admitted topic identity assessment',()=>{
 it('keeps full old anchors beyond eight recent turns and beyond the twenty-key selection, with complete query bindings',async()=>{
  const f=fixture()
  await assessAttendedSessionMessage(f.input)
  const options=spies.classify.mock.calls[0]![0]
  expect(options.recentUserTurns).toHaveLength(8)
  expect(options.topicAnchors).toHaveLength(26)
  expect(options.topicAnchors[0]).toEqual({topicLabel:'legacy subject',messages:[{role:'user',text:f.oldText},{role:'assistant',text:'Full assistant context'},{role:'user',text:'Back to original'}]})
  expect(options.knownTopicsThisSession).toHaveLength(20)
  expect(options.knownTopicsThisSession.at(-1)).toBe('legacy subject')
  expect(options.knownTopicsThisSession).not.toContain('subject-0')
  expect(boundScopeSources(options)).toEqual([f.source,f.annotationSource])
 })
 it('uses the canonical message ID for a stable run scope on replay',async()=>{
  const f=fixture()
  await assessAttendedSessionMessage(f.input)
  await assessAttendedSessionMessage(f.input)
  expect(spies.classify.mock.calls.map(([options])=>options.runId)).toEqual(['memory-topic-current','memory-topic-current'])
 })
 it('rechecks input authority when consuming the result; anchor evidence does not authorize a stale source',async()=>{
  const f=fixture(),assessment=await assessAttendedSessionMessage(f.input)
  spies.proof.mockRejectedValueOnce(new Error('source now held'))
  await expect(assessment.defer()).rejects.toThrow('source now held')
  expect(spies.prepare).not.toHaveBeenCalled()
 })
 it('rejects selector mutation after assessment before preparing an annotation',async()=>{
  const f=fixture(),assessment=await assessAttendedSessionMessage(f.input)
  f.input.message.id='mutated'
  await expect(assessment.defer()).rejects.toMatchObject({code:'scope_source_changed'})
  expect(spies.prepare).not.toHaveBeenCalled()
 })
 it('retains complete tool-call/result context and following assistants under the preceding topic',()=>{
  const evidence=topicEvidenceFromHistory([
   {role:'user',content:'Acorn proposal',topicLabel:'Exact Legacy'},
   {role:'assistant',content:[{type:'tool_use',id:'call',name:'search',input:{query:'Acorn evidence'}}]},
   {role:'user',content:[{type:'tool_result',toolUseId:'call',name:'search',content:'Full Acorn evidence'}]},
   {role:'assistant',content:'Acorn conclusion'},
   {role:'user',content:'A genuinely unclassified user turn'},
   {role:'assistant',content:'Not Acorn context'},
  ])
  expect(evidence.topicAnchors).toEqual([{topicLabel:'Exact Legacy',messages:[
   {role:'user',text:'Acorn proposal'},
   {role:'assistant',text:'Tool call search: {"query":"Acorn evidence"}'},
   {role:'user',text:'Tool result: Full Acorn evidence'},
   {role:'assistant',text:'Acorn conclusion'},
  ]}])
  expect(evidence.knownTopicsThisSession).toEqual(['Exact Legacy'])
 })
 it('never shares an uncategorized bucket or attaches an assistant across an unannotated user',()=>{
  const evidence=topicEvidenceFromHistory([
   {role:'user',content:'Known',topicLabel:'Human label'}, {role:'assistant',content:'Known answer'},
   {role:'user',content:'Unknown',topicLabel:'(uncategorized)'},{role:'assistant',content:'Not known answer'},
   {role:'user',content:'No annotation'},{role:'assistant',content:'Also not known'},
  ])
  expect(evidence).toEqual({knownTopicsThisSession:['Human label'],topicAnchors:[{topicLabel:'Human label',messages:[{role:'user',text:'Known'},{role:'assistant',text:'Known answer'}]}]})
 })
})
