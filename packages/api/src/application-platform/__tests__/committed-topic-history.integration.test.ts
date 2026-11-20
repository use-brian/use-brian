/** Committed annotations preserve the original conversation body and its source evidence. */
import pg from 'pg'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {publishNativeSessionMessageBatch,readAdmittedSessionQuery,type ConversationFrame} from '../../db/conversation-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {addSessionMessage,type SessionMessage} from '../../db/sessions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {assessAttendedSessionMessage} from '../../routes/attended-turn-routing.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
type Authority=Awaited<ReturnType<Fixture['modelContext']>>
const annotationLabel='Fictional committed guarded-history annotation'
const guardedPayload='Fictional body retained from a revocable memory'
const captureSQL='SELECT capture_conversation_query('

function captureStatements(spy: ReturnType<typeof traceCapture>) {
 return (spy.mock.calls as unknown as readonly [unknown,unknown][]).flatMap(([statement,parameters])=>
  typeof statement==='string'&&statement.startsWith(captureSQL)?[{statement,parameters}]:[])
}
function traceCapture() {
 return vi.spyOn(pg.Client.prototype,'query')
}
async function original(f:Fixture,authority:Authority,message:SessionMessage) {
 return readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:message.sequenceNum,
  topicThroughSequence:message.sequenceNum-1,currentMessageId:message.id,currentMessageSequence:message.sequenceNum,authority})
}
async function annotate(f:Fixture,authority:Authority,message:SessionMessage,frame:ConversationFrame,label=annotationLabel,expectedRevision?:string) {
 const annotation=await writeSessionContextRevision({sessionId:f.session.id,parentId:message.id,kind:'message_annotation',
  content:{topicLabel:label,topicConfidence:1,replyToText:null},authority,expectedRevision,
  derivation:{producer:'fixture:guarded-history-reserve',sources:boundScopeSources(frame)}})
 expect(annotation).not.toBeNull()
 return annotation!
}
const refresh=(frame:ConversationFrame,authority:Authority,message:SessionMessage,id:string)=>
 frame.current(authority,message.sequenceNum,{id:message.id,sequence:message.sequenceNum,annotationRevisionId:id})
const fresh=(f:Fixture,authority:Authority,message:SessionMessage)=>
 readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:message.sequenceNum,
  topicThroughSequence:message.sequenceNum,currentMessageId:message.id,currentMessageSequence:message.sequenceNum,authority})

describe.sequential('[COMP:api/native-chat-read-cost] guarded original conversation body refresh',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})

 it('preserves body values and every exact original source while independently capturing the new annotation',async()=>{
  const f=await persistentContextFixture()
  await f.pool.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=false WHERE id=$1',[f.workspaceId])
  try{
   const message=(await f.history()).at(-1)!,authority=await f.modelContext(f.firstId)
   const captured=await original(f,authority,message)
   const originalBodySources=structuredClone(boundScopeSources(captured.history))
   expect(originalBodySources).toHaveLength(captured.history.length+1)
   const annotation=await annotate(f,authority,message,captured)
   const spy=traceCapture()
   try{
    const result=await refresh(captured,authority,message,annotation.id)
    expect(captureStatements(spy)).toEqual([{
     statement:'SELECT capture_conversation_query($1,$2,NULL,$3) AS value',
     parameters:[f.workspaceId,f.session.id,message.sequenceNum],
    }])
    expect(result.history).toEqual(captured.history)
    expect(boundScopeSources(result.history)).toEqual(originalBodySources)
    expect(result.history.map(boundScopeSources)).toEqual(captured.history.map(boundScopeSources))
    expect(result.annotations.at(-1)).toMatchObject({id:message.id,topicLabel:annotationLabel})
    const independent=await fresh(f,await f.modelContext(f.firstId),message)
    expect(result.history).toEqual(independent.history)
    expect(result.annotations).toEqual(independent.annotations)
    expect(boundScopeSources(result.history)).toEqual(boundScopeSources(independent.history))
    expect(boundScopeSources(result.annotations)).toEqual(boundScopeSources(independent.annotations))
   }finally{spy.mockRestore()}
  }finally{await f.cleanup()}
 })

 it('refreshes history through the attended routing continuation after the topic commits',async()=>{
  const f=await persistentContextFixture()
  await f.pool.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=false WHERE id=$1',[f.workspaceId])
  try{
   const message=(await f.history()).at(-1)!,authority=await f.modelContext(f.firstId)
   const assessment=await assessAttendedSessionMessage({authority,session:f.session,message,model:'fixture',
    provider:{name:'fictional-topic',models:['fixture'],createSession(){throw new Error('Unexpected fixture query session')},async *stream(){
     yield{type:'message_start',model:'fixture'}
     yield{type:'text_delta',text:JSON.stringify({topic_label:annotationLabel,state:'continue',confidence:0.9})}
     yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:3,outputTokens:2}}
    }}})
   const continuation=await assessment.publish()
   const spy=traceCapture()
   try{
    const prepared=await continuation.readHistory(authority)
    expect(captureStatements(spy)).toEqual([{
     statement:'SELECT capture_conversation_query($1,$2,NULL,$3) AS value',
     parameters:[f.workspaceId,f.session.id,message.sequenceNum],
    }])
    expect(prepared.messages.at(-1)).toMatchObject({id:message.id,topicLabel:annotationLabel.toLowerCase()})
    expect(prepared.messages.map(row=>row.content)).toEqual(continuation.history.map(row=>row.content))
    expect(await prepared.readTurnCount(authority)).toBe(2)
   }finally{spy.mockRestore()}
  }finally{await f.cleanup()}
 })

 it('withholds stale body and topic bytes after an ancestor is reclassified',async()=>{
  const f=await persistentContextFixture()
  await f.pool.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=false WHERE id=$1',[f.workspaceId])
  try{
   await f.history()
   const writer=await f.modelContext(f.ownerId)
   const memory=await f.memory('Fictional retained permission precursor')
   const readable=await createDbMemoryStore().getById(writer.execution.security.access,memory.id)
   const [guarded]=await publishNativeSessionMessageBatch({sessionId:f.session.id,authority:writer,derivationTarget:f.envelope,
    derivation:{producer:'fixture:revoked-guarded-body',sources:boundScopeSources(readable!)},messages:[{role:'assistant',content:guardedPayload}]})
   const message=await addSessionMessage({sessionId:f.session.id,role:'user',senderUserId:f.firstId,
    content:[{type:'text',text:'Fictional current guarded-history request'}],scope:f.envelope})
   const authority=await f.modelContext(f.firstId),captured=await original(f,authority,message)
   expect(captured.history.find(row=>row.id===guarded.id)?.content).toBe(guardedPayload)
   const annotation=await annotate(f,authority,message,captured)
   const ownerQuery=f.pool.query
   const spy=traceCapture(),ownerSpy=vi.spyOn(f.pool,'query')
   let reclassified=false
   ownerSpy.mockImplementation(function(this:typeof f.pool,...args:unknown[]){
    const result=Reflect.apply(ownerQuery,this,args)
    if(typeof args[0]!=='string'||!args[0].includes("UNION ALL SELECT read_scope_source(h.workspace_id,'session_context_revision'")||reclassified)return result
    return Promise.resolve(result).then(async metadata=>{
     const changed=await Reflect.apply(ownerQuery,this,["UPDATE memories SET sensitivity='confidential' WHERE id=$1",[memory.id]])
     expect(changed.rowCount).toBe(1)
     reclassified=true
     return metadata
    })
   } as typeof ownerQuery)
   try{
    const observed=await refresh(captured,authority,message,annotation.id).then(value=>({value}),error=>({error}))
    expect(reclassified).toBe(true)
    expect(captureStatements(spy).some(({statement})=>statement.includes('NULL,$3'))).toBe(true)
    if('error'in observed){
     const refusal=observed.error as {code?:string;reason?:string;diagnostic?:string}
     expect(refusal.code==='scope_source_changed'||refusal.reason==='caller_evidence_unavailable'
      &&['source_held','source_reclassified','source_changed','source_unverifiable'].includes(refusal.diagnostic??'')).toBe(true)
    }else{
     expect(observed.value.history.some(row=>row.id===guarded.id)).toBe(false)
     expect(observed.value.annotations.some(row=>row.topicLabel===annotationLabel)).toBe(false)
     const independent=await fresh(f,await f.modelContext(f.firstId),message)
     expect(observed.value.history).toEqual(independent.history)
     expect(observed.value.annotations).toEqual(independent.annotations)
    }
   }finally{ownerSpy.mockRestore();spy.mockRestore()}
  }finally{await f.cleanup()}
 })

 it('withholds the retained pre-edit body when an older authored value changes',async()=>{
  const f=await persistentContextFixture()
  await f.pool.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=false WHERE id=$1',[f.workspaceId])
  try{
   const rows=await f.history(),message=rows.at(-1)!,authority=await f.modelContext(f.firstId)
   const captured=await original(f,authority,message)
   const annotation=await annotate(f,authority,message,captured)
   const replacement=[{type:'text',text:'Fictional edited authored body'}]
   await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[rows[0].id,JSON.stringify(replacement)])
   const freshAuthority=await f.modelContext(f.firstId)
   const independent=await fresh(f,freshAuthority,message)
   expect(independent.history[0].content).toEqual(replacement)
   const observed=await refresh(captured,authority,message,annotation.id).then(value=>({value}),error=>({error}))
   if('error'in observed)expect(observed.error).toMatchObject({code:'scope_source_changed'})
   else expect(observed.value.history).toEqual(independent.history)
  }finally{await f.cleanup()}
 })

 it('uses the canonical full refresh when the remembered annotation revision has been superseded',async()=>{
  const f=await persistentContextFixture()
  await f.pool.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=false WHERE id=$1',[f.workspaceId])
  try{
   const message=(await f.history()).at(-1)!,authority=await f.modelContext(f.firstId)
   const captured=await original(f,authority,message)
   const annotation=await annotate(f,authority,message,captured)
   const replacementAuthority=await f.modelContext(f.firstId),replacementFrame=await original(f,replacementAuthority,message)
   const replacement='Fictional replacement topic for the same message'
   await annotate(f,replacementAuthority,message,replacementFrame,replacement,annotation.id)
   const spy=traceCapture()
   try{
    const result=await refresh(captured,authority,message,annotation.id)
    expect(captureStatements(spy)).toEqual([{
     statement:'SELECT capture_conversation_query($1,$2,$3,$4) AS value',
     parameters:[f.workspaceId,f.session.id,message.sequenceNum,message.sequenceNum],
    }])
    expect(result.history).toEqual(captured.history)
    expect(result.annotations.at(-1)).toMatchObject({id:message.id,topicLabel:replacement})
   }finally{spy.mockRestore()}
  }finally{await f.cleanup()}
 })
})
