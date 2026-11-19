/** [COMP:api/native-turn-frame] Titles share canonical publication, retaining their stricter source contract. */
import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {readSessionTitle} from '../../db/session-title-store.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/native-turn-frame] canonical title publication',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext(f.firstId)
  const captured=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  const sources=boundScopeSources(captured),id=randomUUID()
  const generation=(await f.pool.query('SELECT session_context_generation::text value FROM sessions WHERE id=$1',[f.session.id])).rows[0].value
  async function write(db:PoolClient,over:{sources?:readonly ScopeSource[];generation?:string;parent?:string;revision?:string;manual?:boolean}={}){
   return (await db.query(`SELECT publish_native_session_context_revision($1,$2,'session_title',$3,$4,$5,'fixture:canonical-title',$6,$7,$8,NULL) value`,
    [f.workspaceId,f.session.id,over.parent??f.session.id,id,JSON.stringify({title:'Fictional canonical title',manual:over.manual??false}),
     JSON.stringify(over.sources??sources),over.revision??null,over.generation??generation])).rows[0].value
  }
  async function fault(sql:string,run:(name:string)=>Promise<void>){
   const name=`title_fault_${randomUUID().replaceAll('-','')}`
   await f.pool.query(`CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN ${sql};END $fixture$`)
   try{await run(name)}finally{await f.pool.query(`DROP FUNCTION ${name}()`)}
  }
  return{f,authority,sources,id,generation,write,fault,first:history[0].id}
 }
 it.each(['commit','named','immediate'] as const)('publishes and reopens one exact frame with %s constraints',async mode=>{
  const {f,authority,sources,id,write}=await setup()
  await withSessionMessagePublication(authority,sources,async db=>{
   if(mode==='immediate')await db.query('SET CONSTRAINTS ALL IMMEDIATE')
   expect((await write(db)).source.resourceId).toBe(id)
   if(mode==='named')await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
  })
  const edges=(await f.pool.query(`SELECT e.source_kind,e.source_id,frame.format FROM scope_derivations d
   JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id
   JOIN native_turn_frames frame ON frame.workspace_id=e.workspace_id AND frame.id=e.source_id
   WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2`,[f.workspaceId,id])).rows
  expect(edges).toHaveLength(1);expect(edges[0]).toMatchObject({source_kind:'session_context_revision',format:2})
  expect(await readSessionTitle(f.session.id,await f.modelContext(f.firstId))).toMatchObject({title:'Fictional canonical title',manual:false,revisionId:id})
  for(const table of ['native_turn_publication_work','native_turn_publication_events','native_turn_publication_seals','native_turn_publication_debt'])
   expect((await f.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0)
 })
 it.each(['generation','head','parent'] as const)('keeps the original %s compare-and-set without allocating a frame',async stale=>{
  const {f,authority,sources,write,generation}=await setup()
  await withSessionMessagePublication(authority,sources,async db=>{
   expect(await write(db,stale==='generation'?{generation:String(BigInt(generation)+1n)}:stale==='head'?{revision:randomUUID()}:{parent:randomUUID()})).toBeNull()
  })
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 it('preserves a manual title against a generated replacement',async()=>{
  const {f,authority,sources,write}=await setup()
  await f.pool.query('UPDATE sessions SET title_manually_set=true WHERE id=$1',[f.session.id])
  await withSessionMessagePublication(authority,sources,async db=>{expect(await write(db)).toBeNull()})
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 it.each(['version','envelope','absence','hold'] as const)('rejects a changed ordinary source %s at the title writer itself',async change=>{
  const {f,authority,sources,first,write,fault}=await setup()
  const raw=(await f.pool.query("SELECT read_scope_source($1,'session_message',$2) value",[f.workspaceId,first])).rows[0].value
  const {held:_,validTo:__,retractedAt:___,...source}=raw
  const sql=change==='version'?`UPDATE session_messages SET content='"Fictional changed source"'::jsonb WHERE id='${first}'`
   :change==='envelope'?`UPDATE session_messages SET sensitivity='confidential' WHERE id='${first}'`
   :change==='absence'?`DELETE FROM session_messages WHERE id='${first}'`
   :`UPDATE session_messages SET scope_held=true WHERE id='${first}'`
  await fault(sql,async name=>{
   await expect(withSessionMessagePublication(authority,sources,async db=>{
    await db.query(`SELECT ${name}()`)
    await write(db,{sources:[source]})
   })).rejects.toThrow()
  })
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 it.each(['head','payload','manual','source-hold','source-body','frame'] as const)('rolls back a completed writer after actual %s mutation before completion',async change=>{
  const {f,authority,sources,first,id,write,fault}=await setup()
  const sql=change==='head'?`DELETE FROM session_title_heads WHERE session_id='${f.session.id}'`
   :change==='payload'?`UPDATE session_context_revision_contents SET content='{"title":"Fictional tampered title","manual":false}'::jsonb WHERE revision_id='${id}'`
   :change==='manual'?`UPDATE sessions SET title_manually_set=true WHERE id='${f.session.id}'`
   :change==='source-hold'?`UPDATE session_messages SET scope_held=true WHERE id='${first}'`
   :change==='source-body'?`UPDATE session_messages SET content='"Fictional changed source"'::jsonb WHERE id='${first}'`
   :`UPDATE session_context_scope_revisions SET scope_held=true WHERE workspace_id='${f.workspaceId}' AND parent_kind='turn_frame'`
  await fault(sql,async name=>{
   await expect(withSessionMessagePublication(authority,sources,async db=>{
    expect(await write(db)).not.toBeNull()
    await db.query(`SELECT ${name}()`)
    await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
   })).rejects.toThrow()
  })
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  expect((await f.pool.query('SELECT session_id FROM session_title_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([])
 })
})
