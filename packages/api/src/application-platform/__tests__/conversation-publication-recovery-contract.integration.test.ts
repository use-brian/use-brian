import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {bindScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {addSessionMessage,claimTurnLease,releaseTurnLease,requestTurnCancel,readSessionMessageScopeSource} from '../../db/sessions.js'
import {createBufferedWebPublication,bufferedWebPublicationDescriptor,discoverBufferedWebPublications} from '../../db/conversation-publication-recovery.js'
import {prepareSessionMessageAnnotation} from '../../db/session-message-annotations.js'
import {withSessionMessagePublication,assertSessionMessagePublicationFrame,acceptSessionMessagePublicationAnnotation,readRetainedContextFrame} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
async function command(f:Fixture,annotation=true){
 const token=await claimTurnLease(f.session.id,f.assistantId);if(!token)throw new Error('Fixture lease unavailable')
 const input=await addSessionMessage({sessionId:f.session.id,role:'user',content:'Fictional durable publication input',senderUserId:f.ownerId,scope:f.envelope})
 const authority=await f.modelContext(),source=await readSessionMessageScopeSource(f.workspaceId,input.id)
 if(!source)throw new Error('Fixture input source unavailable')
 const sources:ScopeSource[]=[source],operation=createBufferedWebPublication(authority,input.id,token)
 const pendingAnnotation=annotation?await prepareSessionMessageAnnotation({sessionId:f.session.id,messageId:input.id,
  classification:bindScopeSources({topic_label:'Planning',confidence:0.9,state:'shift' as const},sources),replyToText:null,authority}):undefined
 const messages=[{role:'assistant',content:'Fictional committed output',channelMessageId:null,senderUserId:null,senderAssistantId:f.assistantId,attachments:[]}]
 return{f,input,authority,sources,operation,pendingAnnotation,messages,token}
}
type Command=Awaited<ReturnType<typeof command>>
async function publish(c:Command,options:{immediate?:boolean;stopped?:boolean;rollback?:boolean;change?:'command'|'actor'|'assistant'|'token'|'operation'|'input';
 savepoint?:{collidingAnnotationId:string;probeFunction:string}}={}){
 const turn=options.stopped?{stoppedTurnToken:c.token}:{turnToken:c.token}
 const operation={...bufferedWebPublicationDescriptor(c.operation,c.authority,turn)}
 if(options.change==='actor')operation.actorUserId=c.f.secondId
 if(options.change==='assistant')operation.assistantId=randomUUID()
 if(options.change==='token')operation.turnToken=randomUUID()
 if(options.change==='operation')operation.operationId=randomUUID()
 if(options.change==='input')operation.inputMessageId=randomUUID()
 const messages=structuredClone(c.messages)
 if(options.change==='command')messages[0].content='Fictional mismatched command'
 return withSessionMessagePublication(c.authority,c.sources,async db=>{
  if(options.immediate)await db.query('SET CONSTRAINTS ALL IMMEDIATE')
  const annotation=assertSessionMessagePublicationFrame(db,c.authority)
  const write=async(descriptor=annotation)=>(await db.query<{value:unknown}>(
   'SELECT publish_native_session_message_batch($1,$2,$3,$4,$5,$6,$7) AS value',
   [c.f.workspaceId,c.f.session.id,JSON.stringify(descriptor?{messages,annotation:descriptor}:messages),'fixture:durable-publication-contract',
    JSON.stringify(c.sources),c.f.envelope,operation])).rows[0].value
  if(options.savepoint){
   if(!annotation)throw new Error('Savepoint fixture requires a compound annotation')
   await db.query('SAVEPOINT failed_publication')
   // a_annotation is inserted after work insertion and the structural FK's
   // DEFERRED bracket. This real primary-key failure skips its IMMEDIATE end.
   await expect(write({...annotation,id:options.savepoint.collidingAnnotationId})).rejects.toMatchObject({
    code:'23505',constraint:'session_context_scope_revisions_pkey'})
   await db.query('ROLLBACK TO SAVEPOINT failed_publication')
   await db.query('SAVEPOINT structural_fk_probe')
   // The actual private FK must reject this statement now, not at COMMIT.
   await expect(db.query(`SELECT ${options.savepoint.probeFunction}()`)).rejects.toMatchObject({
    code:'23503',constraint:'native_turn_publication_operation'})
   await db.query('ROLLBACK TO SAVEPOINT structural_fk_probe')
   await db.query('RELEASE SAVEPOINT structural_fk_probe')
   await db.query('RELEASE SAVEPOINT failed_publication')
  }
  const result=await write()
  if(annotation)acceptSessionMessagePublicationAnnotation(db,c.authority,(result as {annotation:unknown}).annotation)
  if(options.rollback)throw new Error('fixture_partial_publication_rollback')
  return result
 },{...turn,pendingAnnotation:c.pendingAnnotation})
}
async function counts(f:Fixture){
 return(await f.pool.query<{messages:number;frames:number;annotations:number;receipts:number}>(`SELECT
  (SELECT count(*)::int FROM session_messages WHERE session_id=$1) messages,
  (SELECT count(*)::int FROM native_turn_frames WHERE session_id=$1) frames,
  (SELECT count(*)::int FROM session_message_annotation_heads WHERE session_id=$1) annotations,
  (SELECT count(*)::int FROM native_conversation_publications WHERE session_id=$1) receipts`,[f.session.id])).rows[0]
}

describe.sequential('[COMP:api/native-turn-frame] durable native publication contract',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it.each([false,true])('commits exact compound membership once with immediate constraints=%s',async immediate=>{
  const f=await persistentContextFixture()
  try{
   const c=await command(f),first=await publish(c,{immediate}),again=await publish(c,{immediate})
   expect(again).toEqual(first)
   expect(await counts(f)).toEqual({messages:2,frames:2,annotations:1,receipts:1})
   const page=await discoverBufferedWebPublications(c.authority,f.session.id)
   expect(page.items).toHaveLength(1)
   const saved=page.items[0];expect(saved.state).toBe('committed')
   if(saved.state!=='committed')throw new Error('Fixture publication not admitted')
   expect(saved.outputs.filter(output=>output.kind==='session_message')).toHaveLength(1)
   expect(saved.outputs.filter(output=>output.kind==='message_annotation')).toHaveLength(1)
   expect(new Set(saved.outputs.map(output=>output.frameId)).size).toBe(2)
   expect((await f.pool.query('SELECT count(*)::int n FROM native_turn_publication_debt')).rows[0].n).toBe(0)
  }finally{await f.cleanup()}
 })
 it('serializes concurrent exact attempts and refuses changed command or binding without another effect',async()=>{
  const f=await persistentContextFixture()
  try{
   const c=await command(f),[first,second]=await Promise.all([publish(c),publish(c)])
   expect(second).toEqual(first)
   const before=await counts(f)
   for(const change of ['command','actor','assistant','token','operation','input'] as const){
    await expect(publish(c,{change})).rejects.toMatchObject({code:'scope_source_changed'})
    expect(await counts(f)).toEqual(before)
   }
  }finally{await f.cleanup()}
 })
 it('rolls back transcript, annotation, exact frames and registration after a partial compound effect',async()=>{
  const f=await persistentContextFixture()
  try{
   const c=await command(f)
   await expect(publish(c,{rollback:true})).rejects.toThrow('fixture_partial_publication_rollback')
   expect(await counts(f)).toEqual({messages:1,frames:0,annotations:0,receipts:0})
   expect((await discoverBufferedWebPublications(c.authority,f.session.id)).items).toEqual([])
   // Absence remains unknown. Only this still-live original invocation can
   // perform its explicit attempt; discovery never invokes it.
   await publish(c)
   expect(await counts(f)).toEqual({messages:2,frames:2,annotations:1,receipts:1})
  }finally{await f.cleanup()}
 })
 it('restores immediate structural FK enforcement after a caught failed publication and permits a real retry',async()=>{
  const f=await persistentContextFixture(),probe=`publication_fk_probe_${randomUUID().replaceAll('-','')}`,missingOperation=randomUUID()
  try{
   const first=await command(f);await publish(first)
   const existing=(await f.pool.query<{id:string}>(`SELECT scope_revision_id AS id FROM session_message_annotation_heads
    WHERE session_id=$1 AND message_id=$2`,[f.session.id,first.input.id])).rows[0].id
   expect(await releaseTurnLease(f.session.id,'completed',first.token)).toBe(true)
   const next=await command(f)
   // Disposable-only, fixed synthetic IDs, no parameters or output/seal port.
   // The app role cannot write this private table directly. Never weaken its
   // ACL, FK, triggers or guard merely to observe current constraint timing.
   await f.pool.query(`CREATE FUNCTION ${probe}() RETURNS void LANGUAGE sql SECURITY DEFINER
    SET search_path=pg_catalog,public,pg_temp AS $probe$
    INSERT INTO native_turn_publication_work(transaction_id,workspace_id,frame_id,session_id,context,original_sources,prepared,publication_id)
    VALUES(txid_current(),'${f.workspaceId}','${randomUUID()}','${f.session.id}','{}','[]','{}','${missingOperation}')
    $probe$;REVOKE ALL ON FUNCTION ${probe}() FROM PUBLIC,app_user;GRANT EXECUTE ON FUNCTION ${probe}() TO app_user`)
   await publish(next,{immediate:true,savepoint:{collidingAnnotationId:existing,probeFunction:probe}})
   expect(await counts(f)).toEqual({messages:4,frames:4,annotations:2,receipts:2})
   expect((await f.pool.query('SELECT count(*)::int n FROM native_turn_publication_work')).rows[0].n).toBe(0)
   expect((await f.pool.query('SELECT count(*)::int n FROM native_conversation_publications WHERE id=$1',[missingOperation])).rows[0].n).toBe(0)
  }finally{await f.pool.query(`DROP FUNCTION IF EXISTS ${probe}()`);await f.cleanup()}
 })
 it('preserves original stopped-buffer admission and refuses it after a successor claim',async()=>{
  for(const successor of [false,true]){
   const f=await persistentContextFixture()
   try{
    const c=await command(f)
    await requestTurnCancel(f.session.id)
    expect(await releaseTurnLease(f.session.id,'stopped_by_user',c.token)).toBe(true)
    const next=successor?await claimTurnLease(f.session.id,f.assistantId):null
    if(successor){
     expect(next).not.toBeNull()
     await expect(publish(c,{stopped:true})).rejects.toMatchObject({code:'scope_source_changed'})
     expect(await counts(f)).toEqual({messages:1,frames:0,annotations:0,receipts:0})
     expect((await f.pool.query('SELECT turn_lease_token FROM sessions WHERE id=$1',[f.session.id])).rows[0].turn_lease_token).toBe(next)
    }else{
     await publish(c,{stopped:true})
     expect(await counts(f)).toEqual({messages:2,frames:2,annotations:1,receipts:1})
     expect((await f.pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[f.session.id])).rows[0]).toEqual({status:'idle',turn_lease_token:null})
    }
   }finally{await f.cleanup()}
  }
 })
 it('returns the newest twenty outcomes first and continues older receipts without widening the actor scope',async()=>{
  const f=await persistentContextFixture()
  try{
   const operations:string[]=[],commands:Command[]=[]
   for(let i=0;i<21;i++){
    const c=await command(f,false);await publish(c)
    operations.push(c.operation.operationId);commands.push(c)
    expect(await releaseTurnLease(f.session.id,'completed',c.token)).toBe(true)
   }
   const authority=commands.at(-1)!.authority,page=await discoverBufferedWebPublications(authority,f.session.id)
   expect(page.scope).toEqual({actorUserId:f.ownerId,assistantId:f.assistantId})
   expect(page.items.map(item=>item.operationId)).toEqual(operations.slice(1).reverse())
   expect(page.nextCursor).not.toBeNull()
   const older=await readRetainedContextFrame(authority,[],async db=>(await db.query<{value:{items:Array<{operationId:string}>;nextCursor:unknown}}>(
    'SELECT read_native_conversation_publications($1,$2,$3,20) AS value',[f.workspaceId,f.session.id,page.nextCursor])).rows[0].value)
   expect(older.items.map(item=>item.operationId)).toEqual([operations[0]])
   expect(older.nextCursor).toBeNull()
   const other=await f.modelContext(f.secondId)
   expect((await discoverBufferedWebPublications(other,f.session.id)).items).toEqual([])
   expect(await counts(f)).toEqual({messages:42,frames:21,annotations:0,receipts:21})
  }finally{await f.cleanup()}
 },180_000)
})
