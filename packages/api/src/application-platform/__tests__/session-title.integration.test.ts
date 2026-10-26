import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,type ScopeSource} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {bindSessionContextRetainedAuthority} from '../../db/session-context-revisions.js'
import {publishSessionTitle,readSessionTitle,sessionTitleHead} from '../../db/session-title-store.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {persistentSourceFixture} from './fixtures/persistent-source.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] actual immutable session titles',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 let independent:Awaited<ReturnType<typeof persistentSourceFixture>>|undefined
 afterEach(async()=>{await independent?.cleanup();independent=undefined;await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture;await f.history()
  const authority=await f.modelContext(),history=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  const command={sessionId:f.session.id,title:'Fictional retained session title',manual:false,expectedRevision:null as string|null,authority,
   derivation:{producer:'fixture:current-session-title',sources:boundScopeSources(history)}}
  return{f,authority,command}
 }
 async function source(f:NonNullable<typeof fixture>,id:string){return(await f.pool.query<{source:ScopeSource}>("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,id])).rows[0].source}
 it('publishes title bytes only in an immutable revision with complete actual query ancestry',async()=>{
  const {f,command}=await setup(),result=await publishSessionTitle(command)
  expect(result).toMatchObject({title:command.title,manual:false})
  expect(boundScopeSources(result!)).toMatchObject([{resourceKind:'session_context_revision',resourceId:result!.revisionId}])
  expect((await f.pool.query('SELECT title,title_manually_set FROM sessions WHERE id=$1',[f.session.id])).rows).toEqual([{title:null,title_manually_set:false}])
  const edges=(await f.pool.query(`SELECT edge.source_kind,edge.source_id,edge.source_version FROM scope_derivations d JOIN scope_derivation_sources edge
   ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2`,[f.workspaceId,result!.revisionId])).rows
  for(const s of command.derivation.sources)expect(edges).toContainEqual({source_kind:s.resourceKind,source_id:s.resourceId,source_version:s.version})
  expect(await readSessionTitle(f.session.id,await f.modelContext(f.firstId))).toMatchObject({title:command.title,revisionId:result!.revisionId})
  await expect(f.pool.query("UPDATE session_context_revision_contents SET content=jsonb_build_object('title','Fictional forged title','manual',false) WHERE revision_id=$1",[result!.revisionId])).rejects.toThrow('scope_evidence_immutable')
  await expect(f.pool.query("UPDATE sessions SET title='Fictional unproved overwrite' WHERE id=$1",[f.session.id])).rejects.toThrow('scope_evidence_missing')
 })
 it('holds a legacy manually flagged scalar and preserves a fresh explicit rename against automatic overwrite',async()=>{
  const {f,command}=await setup()
  await f.pool.query("UPDATE sessions SET title='Fictional legacy secret',title_manually_set=true WHERE id=$1",[f.session.id])
  expect(await readSessionTitle(f.session.id,await f.modelContext())).toBeNull()
  expect(await publishSessionTitle(command)).toBeNull()
  const authority=await f.modelContext(),authored=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,authority})
  const manual=await publishSessionTitle({...command,title:'Fictional explicitly authored title',manual:true,authority,derivation:{producer:'fixture:explicit-title',sources:boundScopeSources(authored)}})
  expect(manual).toMatchObject({title:'Fictional explicitly authored title',manual:true})
  expect(await publishSessionTitle({...command,authority:await f.modelContext(),expectedRevision:manual!.revisionId})).toBeNull()
  expect(await readSessionTitle(f.session.id,await f.modelContext())).toMatchObject({title:manual!.title,revisionId:manual!.revisionId})
 })
 it('denies a contracted reader while the independently authorized title reader and immutable observations stay usable',async()=>{
  const {f,command}=await setup(),result=await publishSessionTitle(command),before=await source(f,result!.revisionId),reader=await f.modelContext(f.firstId)
  expect(await readSessionTitle(f.session.id,reader)).toMatchObject({title:command.title})
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(readSessionTitle(f.session.id,reader)).rejects.toMatchObject({reason:'authority_changed'})
  expect(await readSessionTitle(f.session.id,await f.modelContext(f.secondId))).toMatchObject({title:command.title})
  expect(await source(f,result!.revisionId)).toEqual(before)
 })
 it('keeps exactly one original CAS winner and no orphan title revision when native updates race',async()=>{
  const {f,command}=await setup(),authorities=await Promise.all([f.modelContext(),f.modelContext()])
  const claims=await Promise.all(authorities.map((authority,index)=>publishSessionTitle({...command,authority,title:'Fictional concurrent title '+index})))
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect(await sessionTitleHead(f.session.id,await f.modelContext())).toBe(claims.find(Boolean)!.revisionId)
  expect((await f.pool.query("SELECT count(*)::int AS n FROM session_context_scope_revisions WHERE session_id=$1 AND parent_kind='session_title'",[f.session.id])).rows).toEqual([{n:1}])
 })
 it('rolls back title bytes, head and derivation after a source actually changes inside the SQL effect',async()=>{
  const {f,command}=await setup(),memory=await f.memory('Fictional title retention source')
  const memorySource=(await f.pool.query<{source:ScopeSource}>("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,memory.id])).rows[0].source
  const name='r3_title_'+randomUUID().replaceAll('-','')
  await f.pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   BEGIN UPDATE memories SET sensitivity='confidential' WHERE id='${memory.id}'::uuid AND sensitivity='internal';RETURN NEW;END $fixture$`)
  try{
   await f.pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON session_title_heads FOR EACH ROW WHEN (NEW.session_id='${f.session.id}'::uuid) EXECUTE FUNCTION public.${name}()`)
   await expect(publishSessionTitle({...command,derivation:{...command.derivation,sources:[...command.derivation.sources,memorySource]}})).rejects.toMatchObject({code:'scope_source_changed',message:'scope_source_changed'})
   expect((await f.pool.query('SELECT id FROM session_context_scope_revisions WHERE session_id=$1',[f.session.id])).rows).toEqual([])
   expect((await f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([])
   expect((await f.pool.query('SELECT sensitivity FROM memories WHERE id=$1',[memory.id])).rows).toEqual([{sensitivity:'internal'}])
  }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON session_title_heads`);await f.pool.query(`DROP FUNCTION public.${name}()`)}
 })
 it('keeps the title command payload, manual mode and CAS claim pinned across asynchronous admission',async()=>{
  const {f,command}=await setup(),pending=publishSessionTitle(command)
  command.title='Fictional substituted title';command.manual=true;command.expectedRevision=randomUUID();command.derivation.producer='fixture:substituted-title'
  const result=await pending
  expect(result).toMatchObject({title:'Fictional retained session title',manual:false})
  expect(await readSessionTitle(f.session.id,await f.modelContext())).toMatchObject({title:'Fictional retained session title',manual:false})
 })
 it('withholds a withdrawn independent source from the actual title reader without poisoning a second reader',async()=>{
  const {f,command}=await setup();independent=await persistentSourceFixture(f);const external=independent
  async function reader(userId=f.ownerId){const authority=await f.modelContext(userId);bindSessionContextRetainedAuthority(authority.execution,(e,s,a)=>external.coordinator.prepare(e,s,a));return authority}
  const title=await publishSessionTitle({...command,authority:await reader(),derivation:{...command.derivation,sources:[...command.derivation.sources,external.root]}})
  const before=await source(f,title!.revisionId)
  expect(await readSessionTitle(f.session.id,await reader())).toMatchObject({title:command.title})
  await external.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
  expect(await readSessionTitle(f.session.id,await reader())).toBeNull()
  expect(await readSessionTitle(f.session.id,await reader(f.secondId))).toMatchObject({title:command.title})
  expect(await source(f,title!.revisionId)).toEqual(before)
 })
 it('does not treat a removed native carrier as permission for a withdrawn independent title source',async()=>{
  const {f,command}=await setup();independent=await persistentSourceFixture(f);const external=independent,authority=await f.modelContext()
  bindSessionContextRetainedAuthority(authority.execution,(e,s,a)=>external.coordinator.prepare(e,s,a))
  const title=await publishSessionTitle({...command,authority,derivation:{...command.derivation,sources:[...command.derivation.sources,external.root]}})
  await f.pool.query('DELETE FROM memories WHERE id=$1',[external.root.resourceId]);await external.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
  const denied=await f.modelContext();bindSessionContextRetainedAuthority(denied.execution,(e,s,a)=>external.coordinator.prepare(e,s,a))
  expect(await readSessionTitle(f.session.id,denied)).toBeNull()
  expect(await external.independentlyAuthorized()).toBe(true)
  const edges=(await f.pool.query(`SELECT edge.source_id FROM scope_derivations d JOIN scope_derivation_sources edge
   ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_id=$2 AND edge.source_kind='external_source'`,[f.workspaceId,title!.revisionId])).rows
  expect(edges).toContainEqual({source_id:external.observations[0].resourceId})
 })
 it('holds a replaced head when metadata discovery races the actual non-owner payload acquisition',async()=>{
  const {f,command}=await setup(),first=await publishSessionTitle(command),second=await publishSessionTitle({...command,
   title:'Fictional replacement title',expectedRevision:first!.revisionId,authority:await f.modelContext()})
  // Both payloads and receipts came from the real canonical publication path.
  // Repoint only their existing valid head to arrange the acquisition race.
  await f.pool.query('UPDATE session_title_heads SET scope_revision_id=$2 WHERE session_id=$1',[f.session.id,first!.revisionId])
  const reader=await f.modelContext(),fence=await f.pool.connect()
  let pending:ReturnType<typeof readSessionTitle>|undefined
  try{
   await fence.query('BEGIN');await fence.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[f.workspaceId])
   pending=readSessionTitle(f.session.id,reader);pending.catch(()=>{})
   await expect.poll(async()=>Number((await f.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE wait_event_type='Lock' AND query='SELECT id FROM workspaces WHERE id=$1 FOR SHARE'`)).rows[0].n),{timeout:5000,interval:20}).toBeGreaterThan(0)
   await fence.query('UPDATE session_title_heads SET scope_revision_id=$2 WHERE session_id=$1',[f.session.id,second!.revisionId])
   await fence.query('COMMIT')
   expect(await pending).toBeNull()
   expect(await readSessionTitle(f.session.id,await f.modelContext())).toMatchObject({title:second!.title,revisionId:second!.revisionId})
  }finally{await fence.query('ROLLBACK');fence.release();await pending?.catch(()=>{})}
 })
 it('prepares current context and retain receipts after the original publication lock is acquired',async()=>{
  const {f,command}=await setup();independent=await persistentSourceFixture(f);const external=independent,authority=await f.modelContext(),prepared:string[]=[]
  bindSessionContextRetainedAuthority(authority.execution,async(e,s,a)=>{const value=await external.coordinator.prepare(e,s,a);prepared.push(a);return value})
  const fence=await f.pool.connect();let pending:ReturnType<typeof publishSessionTitle>|undefined
  try{
   await fence.query('BEGIN');await fence.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[f.workspaceId])
   pending=publishSessionTitle({...command,authority,derivation:{...command.derivation,sources:[...command.derivation.sources,external.root]}});pending.catch(()=>{})
   await expect.poll(async()=>Number((await f.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE wait_event_type='Lock' AND query='SELECT lock_native_session_context_publication($1,$2)'`)).rows[0].n),{timeout:5000,interval:20}).toBeGreaterThan(0)
   // Actual independent source authorization remains fresh for the effect,
   // rather than aging while this unrelated native writer owns the row lock.
   expect(prepared).toEqual([])
   await fence.query('COMMIT')
   expect(await pending).toMatchObject({title:command.title})
   expect(prepared).toEqual(['context','retain'])
   const reader=await f.modelContext();bindSessionContextRetainedAuthority(reader.execution,(e,s,a)=>external.coordinator.prepare(e,s,a))
   expect(await readSessionTitle(f.session.id,reader)).toMatchObject({title:command.title})
  }finally{await fence.query('ROLLBACK');fence.release();await pending?.catch(()=>{})}
 })
 it('prepares the original query acquisition receipt inside each actual non-owner read frame',async()=>{
  fixture=await persistentContextFixture('confidential');const f=fixture;await f.history();independent=await persistentSourceFixture(f);const external=independent,carrier=await external.writeTranscript(),authority=await f.modelContext(),locked:boolean[]=[]
  bindSessionContextRetainedAuthority(authority.execution,async(e,s,a)=>{
   const probe=await f.pool.connect();let held=false
   try{
    await probe.query('BEGIN')
    try{await probe.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT',[f.workspaceId])}
    catch(error){if((error as {code?:unknown}).code!=='55P03')throw error;held=true}
   }finally{await probe.query('ROLLBACK');probe.release()}
   locked.push(held)
   return external.coordinator.prepare(e,s,a)
  })
  const result=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum,authority})
  // Candidate selection is outside payload acquisition. Both actual payload
  // and return decisions must hold the canonical reader's real workspace lock.
  expect(locked).toEqual([false,true,true])
  expect(result.history.map(row=>row.id)).toContain(carrier.id)
  expect(boundScopeSources(result).some(s=>s.resourceKind==='external_source')).toBe(true)
 })
})
