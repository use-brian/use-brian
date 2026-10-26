import {readFileSync} from 'node:fs'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {bindScopeSources,boundScopeSources,type TopicClassification} from '@use-brian/core'
import {getAppPool,getPool,applyRLSGucs,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {addSessionMessage} from '../../db/sessions.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {writeSessionMessageAnnotation} from '../../db/session-message-annotations.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const{assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const migration=readFileSync(new URL('../../../migrations/8061_application_session_field_query_observations.sql',import.meta.url),'utf8')
const start=migration.indexOf('CREATE FUNCTION read_native_application_session_projection(')
const original=migration.slice(start,migration.indexOf('REVOKE ALL ON FUNCTION read_native_application_session_projection',start))
 .replace('CREATE FUNCTION read_native_application_session_projection','CREATE FUNCTION fixture_r3_original_projection')
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
describe.sequential('[COMP:api/application-persistence] native query capture equivalence',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{await getPool().query('DROP FUNCTION IF EXISTS fixture_r3_original_projection(uuid,uuid,integer,text)');await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){fixture=await persistentContextFixture();const f=fixture;await f.history();await f.pool.query(original)
  await f.pool.query('GRANT EXECUTE ON FUNCTION fixture_r3_original_projection(uuid,uuid,integer,text) TO app_user');return f}
 async function compare(f:Fixture,through:number,type='session_message'){
  const execution=await f.execution(f.firstId),db=await getAppPool().connect()
  try{return await runWithAgentAccess(execution.security.access,async()=>{
   await execution.security.authority.assertCurrent();await db.query('BEGIN');await applyRLSGucs(db,f.firstId)
   const args=[f.workspaceId,f.session.id,through,type]
   const sql=type==='session_message'?'SELECT * FROM read_native_application_session_history($1,$2,$3)':'SELECT * FROM read_native_application_session_topics($1,$2,$3)'
   const actual=(await db.query(sql,args.slice(0,3))).rows
   const expected=(await db.query('SELECT * FROM fixture_r3_original_projection($1,$2,$3,$4)',args)).rows
   expect(actual).toEqual(expected);await db.query('COMMIT');await execution.security.authority.assertCurrent();return actual
  })}finally{await rollbackAndRelease(db)}
 }
 it('matches original body and annotation values, field identities and complete query evidence without private rows',async()=>{
  const f=await setup(),authority=await f.modelContext(f.firstId),query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,topicThroughSequence:2,authority})
  const classification=bindScopeSources<TopicClassification>({topic_label:'fictional captured topic',state:'continue',confidence:0.9},boundScopeSources(query))
  expect(await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:query.history.at(-1)!.id,classification,replyToText:'Fictional captured reply',authority})).not.toBeNull()
  await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional private query marker'}],scope:{...f.envelope,userId:f.secondId}})
  const body=await compare(f,4),annotations=await compare(f,4,'session_message_annotation')
  expect(body).toHaveLength(4);expect(annotations).toHaveLength(2);expect(JSON.stringify(body)).not.toContain('Fictional private query marker')
  expect(JSON.stringify(annotations)).toContain('fictional captured topic')
 })
 it('rolls field capture and a source contraction back before returning bytes and preserves a fresh independent reader',async()=>{
  const f=await setup(),authority=await f.modelContext(f.firstId),query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  const memory=await f.memory('Fictional mid-capture source'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  const [message]=await publishNativeSessionMessageBatch({sessionId:f.session.id,authority,derivationTarget:f.envelope,
   derivation:{producer:'fixture:capture-source-race',sources:[...boundScopeSources(query),...boundScopeSources(row!)]},messages:[{role:'assistant',content:'Fictional guarded capture payload'}]})
  const count=async()=>(await f.pool.query('SELECT count(*)::int AS n FROM application_field_observations WHERE workspace_id=$1',[f.workspaceId])).rows[0].n
  const before=await count()
  await f.pool.query(`CREATE FUNCTION fixture_r3_capture_contraction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fixture$
   BEGIN IF NEW.workspace_id='${f.workspaceId}'::uuid AND NEW.source_kind='session_message' AND NEW.source_id='${message.id}'::uuid THEN
    UPDATE memories SET sensitivity='confidential' WHERE id='${memory.id}'::uuid;END IF;RETURN NEW;END $fixture$`)
  await f.pool.query('CREATE TRIGGER fixture_r3_capture_contraction AFTER INSERT ON application_field_observations FOR EACH ROW EXECUTE FUNCTION fixture_r3_capture_contraction()')
  try{
   await expect(readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:4,authority})).rejects.toMatchObject({message:'scope_source_changed'})
   expect(await count()).toBe(before)
   expect((await f.pool.query('SELECT sensitivity FROM memories WHERE id=$1',[memory.id])).rows[0].sensitivity).toBe('internal')
  }finally{await f.pool.query('DROP TRIGGER fixture_r3_capture_contraction ON application_field_observations');await f.pool.query('DROP FUNCTION fixture_r3_capture_contraction()')}
  const current=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:4,authority:await f.modelContext(f.secondId)})
  expect(JSON.stringify(current.history)).toContain('Fictional guarded capture payload')
 })
 it('preserves an actual extension of the original capture contract through fallback',async()=>{
  const f=await setup(),original=(await f.pool.query<{definition:string;body:string}>("SELECT pg_get_functiondef(p.oid) AS definition,p.prosrc AS body FROM pg_proc p WHERE p.oid='public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure")).rows[0]
  try{
   await f.pool.query(original.definition.replace(original.body,original.body.replace('BEGIN',"BEGIN\n IF p_type='session_message' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;")))
   await expect(readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority:await f.modelContext(f.firstId)})).rejects.toMatchObject({message:'scope_operation_denied'})
  }finally{await f.pool.query(original.definition)}
  expect(await compare(f,3)).toHaveLength(4)
 })
 it('executes its current contract, rejects an owner profile, and exposes no caller-supplied batch envelope',async()=>{
  const f=await setup()
  // A stale contract would return NULL before the owner-profile refusal. This
  // control proves the actual optimized implementation is exercised.
  await expect(f.pool.query('SELECT capture_native_session_projection_batch($1,$2,3,$3)',[f.workspaceId,f.session.id,'session_message'])).rejects.toMatchObject({message:'access_unavailable',code:'42501'})
  const db=await getAppPool().connect()
  try{await expect(db.query('SELECT capture_native_session_projection_batch($1,$2,3,$3)',[f.workspaceId,f.session.id,'session_message'])).rejects.toMatchObject({code:'42501'})}finally{db.release()}
  expect(await compare(f,3)).toHaveLength(4)
 })
 it('falls back when the original canonical ancestry contract is extended',async()=>{
  const f=await setup(),original=(await f.pool.query<{definition:string;body:string}>("SELECT pg_get_functiondef(p.oid) AS definition,p.prosrc AS body FROM pg_proc p WHERE p.oid='public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure")).rows[0]
  try{
   await f.pool.query(original.definition.replace(original.body,original.body.replace('BEGIN',"BEGIN\n IF k='session_message' THEN RETURN false;END IF;")))
   await expect(readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority:await f.modelContext(f.firstId)})).rejects.toMatchObject({message:'scope_operation_denied'})
  }finally{await f.pool.query(original.definition)}
  expect(await compare(f,3)).toHaveLength(4)
 })

 it('holds a changed canonical ancestry configuration even when its body is unchanged',async()=>{
  const f=await setup(),authority=await f.modelContext(f.firstId),query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  const memory=await f.memory('Fictional configured ancestry source'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  await publishNativeSessionMessageBatch({sessionId:f.session.id,authority,derivationTarget:f.envelope,
   derivation:{producer:'fixture:ancestry-configuration',sources:[...boundScopeSources(query),...boundScopeSources(row!)]},messages:[{role:'assistant',content:'Fictional configuration-guarded payload'}]})
  const original=(await f.pool.query<{definition:string}>("SELECT pg_get_functiondef('public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure) AS definition")).rows[0]
  try{
   await f.pool.query("ALTER FUNCTION application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean) SET app.agent_clearance='public'")
   await expect(readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:4,authority:await f.modelContext(f.firstId)})).rejects.toMatchObject({message:'scope_operation_denied'})
  }finally{await f.pool.query(original.definition);await f.pool.query('ALTER FUNCTION application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean) RESET app.agent_clearance')}
  expect(await compare(f,4)).toHaveLength(5)
 })

})
