/** [COMP:api/channel-recording] The recording privacy guard retains the exact
 * historical source closure when its recursive traversal changes shape. */
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'

const db=new PGlite(),workspace=randomUUID(),foreignWorkspace=randomUUID()
const original=await readFile(new URL('../../migrations/8135_channel_recording_privacy_hold.sql',import.meta.url),'utf8')
function originalDefinition(name:string){
 const start=original.indexOf(`CREATE FUNCTION ${name}(`)
 if(start<0)throw new Error(`Missing original recording privacy function: ${name}`)
 return original.slice(start,original.indexOf('$$;',start)+3)
}
const tables=['scope_derivation_sources','scope_derivations','application_field_observation_sources',
 'application_field_observations','application_field_resources','session_messages','session_context_scope_revisions',
 'session_state','episodic_memories','analytics_events','sessions'] as const
async function session(held=false,w=workspace,id=randomUUID()){
 await db.query('INSERT INTO sessions VALUES($1,$2,$3)',[id,w,held]);return id
}
async function message(parent:string,id=randomUUID()){
 await db.query('INSERT INTO session_messages VALUES($1,$2)',[id,parent]);return id
}
async function revision(parent:string,w=workspace,id=randomUUID()){
 await db.query('INSERT INTO session_context_scope_revisions VALUES($1,$2,$3)',[id,w,parent]);return id
}
async function edges(kind:string,id:string,targets:Array<[string,string]>,version='1',w=workspace){
 const derivation=randomUUID()
 await db.query('INSERT INTO scope_derivations VALUES($1,$2,$3,$4,$5)',[derivation,w,kind,id,version])
 for(const [sourceKind,sourceId] of targets)await db.query('INSERT INTO scope_derivation_sources VALUES($1,$2,$3,$4,$5)',[w,derivation,sourceKind,sourceId,version])
}
async function observation(field:string,kind:string,id:string,version='1',w=workspace){
 await db.query('INSERT INTO application_field_observations VALUES($1,$2,$3,$4,$5)',[w,field,version,kind,id])
}
async function observationEdge(field:string,kind:string,id:string,version='1',w=workspace){
 await db.query('INSERT INTO application_field_observation_sources VALUES($1,$2,$3,$4,$5,$6)',[w,field,version,kind,id,'1'])
}
async function anchor(field:string,id:string,type='session_message',origin:unknown={kind:'native',moduleKey:'native'},w=workspace){
 await db.query('INSERT INTO application_field_resources VALUES($1,$2,$3,$4,$5)',[field,w,origin,type,id])
}
async function compare(kind:string|null,id:string|null,expected:boolean,w:string|null=workspace){
 const rows=await db.query<{old:boolean;current:boolean}>(`SELECT fixture_original_recording_guard($1,$2,$3) old,
 recording_source_read_allowed($1,$2,$3) current`,[w,kind,id])
 expect(rows.rows[0]).toEqual({old:expected,current:expected})
}

beforeAll(async()=>{
 await db.exec(`CREATE ROLE privacy_owner NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE privacy_reader LOGIN NOSUPERUSER NOBYPASSRLS;
 GRANT CREATE ON SCHEMA public TO privacy_owner;SET ROLE privacy_owner;
 CREATE TABLE sessions(id uuid PRIMARY KEY,workspace_id uuid,recording_privacy_held boolean NOT NULL);
 CREATE TABLE session_messages(id uuid PRIMARY KEY,session_id uuid);
 CREATE TABLE session_context_scope_revisions(id uuid PRIMARY KEY,workspace_id uuid,session_id uuid);
 CREATE TABLE session_state(id uuid PRIMARY KEY,workspace_id uuid,session_id uuid);
 CREATE TABLE episodic_memories(id uuid PRIMARY KEY,workspace_id uuid,session_id uuid);
 CREATE TABLE analytics_events(id uuid PRIMARY KEY,workspace_id uuid,session_id uuid);
 CREATE TABLE scope_derivations(id uuid PRIMARY KEY,workspace_id uuid,resource_kind text,resource_id uuid,resource_version text,
 UNIQUE(workspace_id,resource_kind,resource_id,resource_version));
 CREATE TABLE scope_derivation_sources(workspace_id uuid,derivation_id uuid,source_kind text,source_id uuid,source_version text,
 PRIMARY KEY(derivation_id,source_kind,source_id));
 CREATE TABLE application_field_observations(workspace_id uuid,resource_id uuid,version text,source_kind text,source_id uuid,
 PRIMARY KEY(resource_id,version));
 CREATE TABLE application_field_observation_sources(workspace_id uuid,resource_id uuid,version text,source_kind text,source_id uuid,source_version text,
 PRIMARY KEY(resource_id,version,source_kind,source_id,source_version));
 CREATE TABLE application_field_resources(id uuid PRIMARY KEY,workspace_id uuid,origin jsonb,type_key text,resource_id uuid);`)
 await db.exec(originalDefinition('session_recording_read_allowed'))
 await db.exec(originalDefinition('recording_source_read_allowed').replace('CREATE FUNCTION recording_source_read_allowed(', 'CREATE FUNCTION fixture_original_recording_guard('))
 // This is the exact authored successor body; the original implementation
 // above remains independently executable rather than mirrored in the test.
 const migration=await readFile(new URL('../../migrations/8247_recording_privacy_ancestry_frontier.sql',import.meta.url),'utf8')
 const body=migration.split('$recording_privacy_frontier$')[1]
 if(!body)throw new Error('Missing canonical recording privacy frontier body')
 await db.exec(`CREATE FUNCTION recording_source_read_allowed(w uuid,k text,i uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$${body}$body$;`)
 await db.exec(`REVOKE ALL ON FUNCTION session_recording_read_allowed(uuid),fixture_original_recording_guard(uuid,text,uuid),recording_source_read_allowed(uuid,text,uuid) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION fixture_original_recording_guard(uuid,text,uuid),recording_source_read_allowed(uuid,text,uuid) TO privacy_reader;
 GRANT ALL ON ALL TABLES IN SCHEMA public TO privacy_reader;
 RESET ROLE;SET SESSION AUTHORIZATION privacy_reader;`)
})
beforeEach(async()=>{await db.exec(`TRUNCATE ${tables.join(',')}`)})
afterAll(async()=>db.close())

describe.sequential('[COMP:api/channel-recording] recording privacy ancestry frontier',()=>{
 it('runs both guards under an ordinary separate reader and preserves SQL/STABLE/definer ownership',async()=>{
  const role=(await db.query<{reader:string;super:boolean;bypass:boolean}>(`SELECT session_user reader,rolsuper super,rolbypassrls bypass FROM pg_roles WHERE rolname=session_user`)).rows[0]
  expect(role).toEqual({reader:'privacy_reader',super:false,bypass:false})
  const routines=(await db.query<{name:string;language:string;volatility:string;definer:boolean;owner:string;settings:string[]}>(`SELECT p.proname name,l.lanname language,p.provolatile volatility,p.prosecdef definer,r.rolname owner,p.proconfig settings
   FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles r ON r.oid=p.proowner
   WHERE p.oid=ANY(ARRAY['recording_source_read_allowed(uuid,text,uuid)'::regprocedure,'fixture_original_recording_guard(uuid,text,uuid)'::regprocedure])`)).rows
  expect(routines).toHaveLength(2)
  for(const routine of routines)expect(routine).toMatchObject({language:'sql',volatility:'s',definer:true,owner:'privacy_owner',settings:['search_path=pg_catalog, public, pg_temp']})
 })
 it.each(['session','session_message','session_context_revision','session_state','episodic_memory','feedback_event'])('retains the %s parent mapping and a fresh hold change',async(kind)=>{
  const parent=await session(),id=kind==='session'?parent:randomUUID()
  if(kind==='session_message')await message(parent,id)
  if(kind==='session_context_revision')await revision(parent,workspace,id)
  const parentTables:Record<string,string>={session_state:'session_state',episodic_memory:'episodic_memories',feedback_event:'analytics_events'}
  const table=parentTables[kind]
  if(table)await db.query(`INSERT INTO ${table} VALUES($1,$2,$3)`,[id,workspace,parent])
  await compare(kind,id,true)
  await db.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[parent])
  await compare(kind,id,false)
 })
 it('follows a held ancestor retained only in an older derivation version',async()=>{
  const root=randomUUID(),held=await session(true),healthy=await session()
  await edges('memory',root,[['session',held]],'old')
  await edges('memory',root,[['session',healthy]],'current')
  await compare('memory',root,false)
 })
 it('follows old observations even when another observation points to healthy history',async()=>{
  const field=randomUUID(),held=await message(await session(true)),healthy=await message(await session())
  await observation(field,'session_message',held,'old')
  await observation(field,'session_message',healthy,'current')
  await compare('application_field',field,false)
 })
 it('follows old observation-source edges across another field and a different session',async()=>{
  const root=randomUUID(),child=randomUUID(),held=await revision(await session(true))
  await observation(root,'unknown',randomUUID(),'old')
  await observation(root,'unknown',randomUUID(),'current')
  await observationEdge(root,'application_field',child,'old')
  await observationEdge(root,'application_field',randomUUID(),'current')
  await observation(child,'session_context_revision',held)
  await compare('application_field',root,false)
 })
 it.each(['session_message','session_message_annotation'])('retains the native %s anchor without an observation',async(type)=>{
  const field=randomUUID(),held=await message(await session(true))
  await anchor(field,held,type)
  await compare('application_field',field,false)
 })
 it.each([
  ['foreign workspace',{kind:'native',moduleKey:'native'},'session_message',false],
  ['generic origin',{kind:'generic',moduleKey:'native'},'session_message',true],
  ['other native module',{kind:'native',moduleKey:'other'},'session_message',true],
  ['other native type',{kind:'native',moduleKey:'native'},'memory',true],
 ] as const)('preserves native anchor exclusion: %s',async(_label,origin,type,sameWorkspace)=>{
  const field=randomUUID(),held=await message(await session(true))
  await anchor(field,held,type,origin,sameWorkspace?workspace:foreignWorkspace)
  await compare('application_field',field,true)
 })
 it('terminates cycles and duplicate diamond paths without losing a held descendant',async()=>{
  const [root,left,right,tip]=Array.from({length:4},()=>randomUUID()),parent=await session()
  await edges('memory',root,[['memory',root],['memory',left],['memory',right]])
  await edges('memory',left,[['memory',tip]])
  await edges('memory',right,[['memory',tip]])
  await edges('memory',tip,[['memory',root],['session',parent]])
  await edges('memory',root,[['memory',tip],['session',parent]],'old')
  await compare('memory',root,true)
  await db.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[parent])
  await compare('memory',root,false)
 })
 it('ignores foreign-workspace derivations and observations but keeps the exact requested workspace',async()=>{
  const root=randomUUID(),field=randomUUID(),held=await session(true,foreignWorkspace)
  await edges('memory',root,[['session',held]],'1',foreignWorkspace)
  await observation(field,'session',held,'1',foreignWorkspace)
  await observationEdge(field,'session',held,'1',foreignWorkspace)
  await compare('memory',root,true);await compare('application_field',field,true)
  await compare('memory',root,false,foreignWorkspace)
  await compare('application_field',field,false,foreignWorkspace)
 })
 it.each(['session','session_message','session_context_revision'])('preserves workspace checks for direct %s parents',async(kind)=>{
  const parent=await session(true,foreignWorkspace),id=kind==='session'?parent:randomUUID()
  if(kind==='session_message')await message(parent,id)
  if(kind==='session_context_revision')await revision(parent,foreignWorkspace,id)
  await compare(kind,id,true)
  await compare(kind,id,false,foreignWorkspace)
 })
 it.each([['session_state','session_state'],['episodic_memory','episodic_memories'],['feedback_event','analytics_events']])('preserves the original unscoped %s parent branch',async(kind,table)=>{
  const parent=await session(true,foreignWorkspace),id=randomUUID()
  await db.query(`INSERT INTO ${table} VALUES($1,$2,$3)`,[id,foreignWorkspace,parent])
  await compare(kind,id,false)
  await compare(kind,id,false,null)
 })
 it.each([['session_state','session_state'],['episodic_memory','episodic_memories'],['feedback_event','analytics_events']])('retains NULL and dangling %s parent behavior',async(kind,table)=>{
  const id=randomUUID()
  await db.query(`INSERT INTO ${table} VALUES($1,$2,NULL)`,[id,workspace])
  await compare(kind,id,true)
  await db.query(`UPDATE ${table} SET session_id=$2 WHERE id=$1`,[id,randomUUID()])
  await compare(kind,id,false)
  await compare(kind,id,false,null)
 })
 it('keeps the distinct missing-parent behavior of messages and local revisions',async()=>{
  const missing=randomUUID(),body=await message(missing),context=await revision(missing)
  await compare('session_message',body,true)
  await compare('session_context_revision',context,false)
  await db.query('UPDATE session_messages SET session_id=NULL WHERE id=$1',[body])
  await db.query('UPDATE session_context_scope_revisions SET session_id=NULL WHERE id=$1',[context])
  await compare('session_message',body,true)
  await compare('session_context_revision',context,true)
 })
 it('does not add a session-workspace restriction to the local revision mapping',async()=>{
  const parent=await session(true,foreignWorkspace),context=await revision(parent)
  await compare('session_context_revision',context,false)
 })
 it('does not add missing or unknown resources as implicit denied sessions',async()=>{
  const held=await session(true)
  for(const kind of ['session','session_message','session_context_revision','unknown'])await compare(kind,randomUUID(),true)
  await compare('unknown',null,true);await compare('session',null,true)
  await compare(null,held,true);await compare(null,null,true)
  await compare('session',held,true,null)
 })
 it('keeps all edge families in the same complete closure, including an observation cycle',async()=>{
  const root=randomUUID(),a=randomUUID(),b=randomUUID(),parent=await session(),body=await message(parent)
  await edges('memory',root,[['application_field',a]])
  await observation(a,'application_field',b,'old')
  await observationEdge(b,'application_field',a)
  await anchor(b,body,'session_message_annotation')
  await compare('memory',root,true)
  await db.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[parent])
  await compare('memory',root,false)
 })
})
