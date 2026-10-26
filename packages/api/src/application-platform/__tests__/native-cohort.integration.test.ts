/** Real equivalence for the original native proof and fresh full cohorts. */
import {readFileSync} from 'node:fs'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,type ScopeSource} from '@use-brian/core'
import {getAppPool,getPool,applyRLSGucs,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const migration=readFileSync(new URL('../../../migrations/8069_native_metadata_extension_contract.sql',import.meta.url),'utf8')
const start=migration.indexOf('CREATE OR REPLACE FUNCTION read_native_attended_memory_evidence(')
const original=migration.slice(start,migration.indexOf('REVOKE ALL ON FUNCTION read_native_attended_memory_evidence',start))
 .replace('CREATE OR REPLACE FUNCTION read_native_attended_memory_evidence','CREATE FUNCTION fixture_r3_original_memory_cohort')
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
type Proof={admitted:boolean;immutable?:unknown[];current?:unknown[]}|null
function sorted(proof:Proof){return proof&&{...proof,...(proof.immutable?{immutable:[...proof.immutable].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}:{}),
 ...(proof.current?{current:[...proof.current].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}:{})}}
describe.sequential('[COMP:api/application-persistence] fresh native cohort equivalence',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{await getPool().query('DROP FUNCTION IF EXISTS fixture_r3_original_memory_cohort(uuid,text[],uuid[],text[])');await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture;await f.history()
  expect((await f.pool.query("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS hash FROM pg_proc WHERE oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure")).rows[0].hash).toBe('b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca')
  await f.pool.query(original);await f.pool.query('GRANT EXECUTE ON FUNCTION fixture_r3_original_memory_cohort(uuid,text[],uuid[],text[]) TO app_user')
  const authority=await f.modelContext(f.firstId),query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  return{f,authority,sources:boundScopeSources(query)}
 }
 async function compare(f:Fixture,sources:readonly ScopeSource[],userId=f.firstId){
  const execution=await f.execution(userId),db=await getAppPool().connect()
  try{return await runWithAgentAccess(execution.security.access,async()=>{
   await db.query('BEGIN');await applyRLSGucs(db,userId)
   const args=[f.workspaceId,sources.map(s=>s.resourceKind),sources.map(s=>s.resourceId),sources.map(s=>s.version)]
   const actual=(await db.query<{value:Proof}>('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',args)).rows[0].value
   const expected=(await db.query<{value:Proof}>('SELECT fixture_r3_original_memory_cohort($1,$2,$3,$4) AS value',args)).rows[0].value
   expect(sorted(actual)).toEqual(sorted(expected));await db.query('COMMIT');return actual
  })}finally{await rollbackAndRelease(db)}
 }
 it('preserves every current and immutable field/context/Memory obligation of the original full proof',async()=>{
  const{f,authority,sources}=await setup(),roots=[...sources]
  for(let n=0;n<17;n++){
   const memory=await f.memory('Fictional cohort source '+n),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
   expect(row).not.toBeNull();roots.push(...boundScopeSources(row!))
  }
  const revision=await writeSessionContextRevision({sessionId:f.session.id,kind:'compact_summary',content:{summary:'Fictional complete cohort',boundarySequence:3},authority,
   derivation:{producer:'fixture:native-cohort-equivalence',sources:roots}})
  expect(revision).not.toBeNull();roots.push(...boundScopeSources(revision!))
  expect(await compare(f,roots)).toMatchObject({admitted:true})
 })
 it('rechecks a contracted current source and keeps an independently authorized reader usable',async()=>{
  const{f,authority,sources}=await setup(),memory=await f.memory('Fictional contracting cohort source'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  const roots=[...sources,...boundScopeSources(row!)];expect(await compare(f,roots)).toMatchObject({admitted:true})
  await f.pool.query("UPDATE memories SET sensitivity='confidential' WHERE id=$1",[memory.id])
  expect(await compare(f,roots)).toEqual({admitted:false});expect(await compare(f,roots,f.secondId)).toMatchObject({admitted:true})
 })
 it('preserves held source refusal across later operations',async()=>{
  const{f,authority,sources}=await setup(),memory=await f.memory('Fictional held cohort source'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  const roots=[...sources,...boundScopeSources(row!)];expect(await compare(f,roots)).toMatchObject({admitted:true})
  await f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[memory.id])
  expect(await compare(f,roots)).toEqual({admitted:false});expect(await compare(f,roots,f.secondId)).toEqual({admitted:false})
 })
 it('uses the original evaluator when its actual SQL contract is extended',async()=>{
  const{f,authority,sources}=await setup(),memory=await f.memory('Fictional extended evaluator source'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  const roots=[...sources,...boundScopeSources(row!)]
  expect(await compare(f,roots)).toMatchObject({admitted:true})
  const saved=(await f.pool.query<{definition:string;body:string}>("SELECT pg_get_functiondef(p.oid) AS definition,p.prosrc AS body FROM pg_proc p WHERE p.oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure")).rows[0]
  try{
   const extended=saved.definition.replace(saved.body,saved.body.replace('BEGIN',"BEGIN\n IF k='memory' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;"))
   expect(extended).not.toBe(saved.definition);await f.pool.query(extended)
   expect(await compare(f,roots)).toEqual({admitted:false})
  }finally{await f.pool.query(saved.definition)}
  expect(await compare(f,roots)).toMatchObject({admitted:true})
 })
 it('keeps cohort helpers private and retains the original mixed-family fallback',async()=>{
  const{f,sources}=await setup(),db=await getAppPool().connect()
  try{await expect(db.query("SELECT read_native_session_cohort_evidence($1,$2,$3,$4,true)",[f.workspaceId,sources.map(s=>s.resourceKind),sources.map(s=>s.resourceId),sources.map(s=>s.version)])).rejects.toMatchObject({code:'42501'})}
  finally{db.release()}
  const privateDb=await getAppPool().connect()
  try{await expect(privateDb.query("SELECT * FROM read_native_session_query_cohort_nodes($1,'[]'::jsonb)",[f.workspaceId])).rejects.toMatchObject({code:'42501'})}finally{privateDb.release()}
  expect(await compare(f,[...sources,{...sources[0],resourceKind:'entity'}])).toBeNull()
 })
})
