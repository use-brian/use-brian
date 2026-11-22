/**
 * Portable brain restore across two owned disposable installations.
 * Driven by fixtures/portable-restore-proof.mjs: the source phase runs on one
 * fresh ordinary-owner chain, the target phase on a second chain with
 * different object identifiers. [COMP:api/portable-restore]
 */
import {readFile,writeFile,mkdir,cp,rm,readdir} from 'node:fs/promises'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {join} from 'node:path'
import pg from 'pg'
import {afterAll,describe,expect,it} from 'vitest'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,claimTurnLease,createPersonalWebSession,releaseTurnLease} from '../../db/sessions.js'
import {bindTurnCompletion} from '../../db/conversation-publication-recovery.js'
import {readAdmittedSessionQuery,publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {captureCrmErasure} from '../../crm-operations/erasure-journal.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {seedHarnessHistory,verifyHarnessHistory,harnessInstalled,harnessRows,type HarnessHistory} from './fixtures/portable-harness-history.js'
import {seedRefusedFamilies,type SeededFamilies} from './fixtures/portable-restore-families.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const {sealJson,unsealJson,unsealFile}=await import(new URL('../../../../../scripts/operations/recovery-common.mjs',import.meta.url).href)
const restore=await import(new URL('../../../scripts/conversation-store/portable-restore.mjs',import.meta.url).href)
const {authenticateConversationInstallation,releaseAuthentication}=await import(new URL('../../../scripts/conversation-store/installation-release.mjs',import.meta.url).href)
const phase=process.env.BRIAN_PORTABLE_RESTORE_PHASE,stateDirectory=process.env.BRIAN_PORTABLE_RESTORE_STATE
// The driver pins the shipped migration set it applied to both chains.
const sourceRoot=process.env.BRIAN_PORTABLE_RESTORE_SOURCE_ROOT
const configuredTaskProof=process.env.BRIAN_PORTABLE_CONFIGURED_TASK_PROOF
const reviewedRoster=process.env.BRIAN_PORTABLE_RESTORE_ROSTER?await restore.loadPortableRoster(process.env.BRIAN_PORTABLE_RESTORE_ROSTER):undefined
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
type Claims={userId:string;sessionId:string;authVersion:number}
type Saved={workspaceId:string;sessionId:string;assistantId:string;private:boolean;ownerClaims:Claims;through:number;turnToken:string}
type Observation=Record<string,unknown>
type State={harness?:HarnessHistory;sessions:Saved[];actors:Record<string,Claims>;workspaces:string[];observations:Record<string,Observation>;
 export:{manifestSha256:string;transactionHorizon:string;rows:number;populatedTables:number};moduleExport:{manifestSha256:string};
 checkpoint:{checkpointSha256:string;records:number};erasedAfterExport:string;erasedBeforeExport:string;
 compiledRecordCount?:number;contractModule:string;contractSlots:string[];oids:{metadata:string;catalog:string;root:string};families:SeededFamilies}

afterAll(async()=>{await getAppPool().end();await getPool().end()})

async function ownerClient(){const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();return client}

/** Admitted history, provenance and denials for every actor and session, plus RLS memory reads. */
async function observe(state:Pick<State,'sessions'|'actors'|'workspaces'>){
 const result:Record<string,Observation>={}
 for(const session of state.sessions)for(const [actor,claims] of Object.entries(state.actors)){
  const key=session.sessionId+':'+actor
  try{
   const authority=await resolveSessionTitleAuthority({claims,sessionId:session.sessionId,readOnly:true})
   const captured=await readAdmittedSessionQuery({sessionId:session.sessionId,throughSequence:session.through,authority})
   result[key]={admitted:true,history:captured.history.map(message=>({id:message.id,role:message.role,content:message.content,
    sequenceNum:message.sequenceNum,senderUserId:message.senderUserId,senderAssistantId:message.senderAssistantId,createdAt:new Date(message.createdAt).toISOString()})),
    provenance:boundScopeSources(captured)}
  }catch(error){result[key]={admitted:false,error:(error as Error).name+':'+(error as Error).message}}
 }
 // Direct protected reads as the non-owner application role under RLS.
 for(const [actor,claims] of Object.entries(state.actors)){
  const client=await getAppPool().connect()
  try{
   await client.query('BEGIN')
   await client.query("SELECT set_config('app.current_user_id',$1,true)",[claims.userId])
   result['memories:'+actor]={rows:(await client.query('SELECT id,summary,user_id FROM memories WHERE workspace_id=ANY($1::uuid[]) ORDER BY id',[state.workspaces])).rows}
   await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');result['memories:'+actor]={error:(error as Error).message}}
  finally{client.release()}
 }
 return result
}

describe.skipIf(phase!=='source').sequential('[COMP:api/portable-restore] portable export from a populated source installation',()=>{
 it('seeds private and shared conversations, records receiving observations and exports anchored archives',async()=>{
  await assertLocalFixture()
  await mkdir(stateDirectory!,{recursive:true,mode:0o700})
  const key=randomBytes(32);await writeFile(join(stateDirectory!,'key'),key,{mode:0o600})
  const sessions:Saved[]=[],actors:Record<string,Claims>={},workspaces:string[]=[]
  let erasedBeforeExport='',erasedAfterExport=''
  for(const personal of [false,true]){
   const f=await persistentContextFixture()
   workspaces.push(f.workspaceId)
   const device=async(userId:string,label:string)=>{const d=(await authSessionStore.create(userId,{deviceLabel:label,userAgent:null,ipAddress:null}))!;return{userId,sessionId:d.id,authVersion:d.authVersion}}
   const owner=await device(f.ownerId,'Fictional portable owner')
   actors[(personal?'private':'shared')+'-owner']=owner
   actors[(personal?'private':'shared')+'-member']=await device(f.firstId,'Fictional portable member')
   const session=personal?await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
    {actorUserId:f.ownerId,authSessionId:owner.sessionId,authVersion:owner.authVersion}):f.session
   const scope={...f.envelope,userId:personal?f.ownerId:null}
   const input=await addSessionMessage({sessionId:session.id,role:'user',content:[{type:'text',text:'Remember the fictional cobalt ledger.'}],senderUserId:f.ownerId,scope})
   const authority=await resolveSessionTitleAuthority({claims:owner,sessionId:session.id,readOnly:false})
   const captured=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:input.sequenceNum,authority})
   // The reply carries its 8277 durable completion header, so restore moves one per session.
   const turnToken=(await claimTurnLease(session.id,f.assistantId))!
   const replies=await publishNativeSessionMessageBatch({sessionId:session.id,authority,derivationTarget:scope,
    derivation:{producer:'fixture:portable-restore',sources:boundScopeSources(captured)},
    messages:[{role:'assistant',senderAssistantId:f.assistantId,content:[{type:'text',text:'The ledger is cobalt.'}]}],
    publication:{turnToken,completion:bindTurnCompletion({operationId:randomUUID(),lane:'web',assistantId:f.assistantId,input:{kind:'session_message',ref:input.id}})}})
   expect(await releaseTurnLease(session.id,'completed',turnToken)).toBe(true)
   sessions.push({workspaceId:f.workspaceId,sessionId:session.id,assistantId:f.assistantId,private:personal,ownerClaims:owner,through:replies.at(-1)!.sequenceNum,turnToken})
   // The released lease leaves its originating token behind (8063); restore must carry it exactly.
   expect((await getPool().query('SELECT turn_lease_token,last_turn_lease_token::text t FROM sessions WHERE id=$1',[session.id])).rows[0]).toEqual({turn_lease_token:null,t:turnToken})
   await f.memory('Fictional shared portable fact')
   await f.memory('Fictional private portable fact',f.ownerId)
   const erased=await f.memory(personal?'Fictional fact erased after export':'Fictional fact erased before export')
   if(personal)erasedAfterExport=erased.id;else erasedBeforeExport=erased.id
  }
  // A stranger from another workspace is denied everywhere.
  const stranger=randomUUID();await getPool().query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[stranger])
  const strangerDevice=(await authSessionStore.create(stranger,{deviceLabel:'Fictional stranger',userAgent:null,ipAddress:null}))!
  actors.stranger={userId:stranger,sessionId:strangerDevice.id,authVersion:strangerDevice.authVersion}
  const erase=async(id:string)=>{const client=await getPool().connect();try{await client.query('BEGIN');await captureCrmErasure(client);
   expect((await client.query('DELETE FROM memories WHERE id=$1',[id])).rowCount).toBe(1);await client.query('COMMIT')}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}}
  await erase(erasedBeforeExport)
  // Durable logical definition with named regprocedure slots bound to shipped readers.
  const contractModule='fixture-portable-'+randomBytes(4).toString('hex'),contractSlots=['public.application_query_anchor_reference(uuid,jsonb,text,text)','public.application_current_query_catalog(uuid,jsonb,text)']
  await getPool().query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader) VALUES($1,'1',ARRAY['portable_reader'],$2::regprocedure,$3::regprocedure)`,
   [contractModule,...contractSlots])
  // One admitted row per validator family that refused historical rows before the validator audit.
  const families=await seedRefusedFamilies()
  const harness=await seedHarnessHistory()
  const observations=await observe({sessions,actors,workspaces})
  expect(Object.values(observations).filter(value=>value.admitted===true).length).toBeGreaterThanOrEqual(3)
  expect(Object.values(observations).filter(value=>value.admitted===false).length).toBeGreaterThanOrEqual(3)
  const client=await ownerClient()
  try{
   let compiledRecordCount:number|undefined
   const compiled=(await client.query("SELECT to_regprocedure('public.compile_conversation_record_page(integer,integer)') IS NOT NULL enabled")).rows[0].enabled
   if(compiled){
    await client.query('SELECT enroll_existing_conversation_records(32)')
    for(let page=0;page<4;page++)await client.query('SELECT compile_conversation_record_page(32,4194304)')
    compiledRecordCount=(await client.query("SELECT count(*)::int n FROM native_conversation_conversion_inputs WHERE kind::text='conversation_record'")).rows[0].n
    expect(compiledRecordCount).toBeGreaterThan(0)
   }
   const exported=await restore.exportPortableBrain({ownerClient:client,destination:join(stateDirectory!,'archive'),key,sourceRoot,roster:reviewedRoster})
   expect(exported.status).toBe('exported')
   const roster=reviewedRoster??await restore.loadPortableRoster()
   expect(exported.tables).toBe(Object.values(roster.tables).filter((entry:any)=>entry.class!=='derived').length)
   if(configuredTaskProof){
    const {evidence}=JSON.parse(await readFile(configuredTaskProof,'utf8'))
    const sourceArchive=join(stateDirectory!,'archive'),scratch=join(stateDirectory!,'archival-proof')
    await mkdir(scratch,{mode:0o700})
    try{
     const manifest=await unsealJson(join(sourceArchive,'manifest.enc'),key,scratch)
     const table=manifest.tables.find((entry:{name:string})=>entry.name==='episode_extraction_items')
     const plain=join(scratch,'extraction-items.rows')
     await unsealFile(join(sourceArchive,table.file),plain,key)
     const row=(await readFile(plain,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(line=>
      typeof line==='string'&&line.includes(evidence.run_id)&&line.includes(evidence.candidate_id))
     expect(row).toContain(evidence.target_record_id)
     expect(row).toContain(evidence.configured_source.batchId)
     expect(row).toContain(evidence.configured_task.title)
    }finally{await rm(scratch,{recursive:true,force:true})}
   }
   expect((await client.query('SELECT count(*)::int n FROM native_turn_completions')).rows[0].n).toBe(2)
   // An archive whose regprocedure slot names an unshipped module reader.
   await client.query(`CREATE FUNCTION public.portable_probe_reader(uuid,jsonb,text,text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS 'SELECT NULL::jsonb'`)
   await client.query('REVOKE ALL ON FUNCTION public.portable_probe_reader(uuid,jsonb,text,text) FROM PUBLIC')
   await client.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader) VALUES('fixture-probe-module','1','{}','public.portable_probe_reader(uuid,jsonb,text,text)'::regprocedure,$1::regprocedure)`,[contractSlots[1]])
   const moduleExport=await restore.exportPortableBrain({ownerClient:client,destination:join(stateDirectory!,'module-archive'),key,sourceRoot,roster:reviewedRoster})
   await client.query("DELETE FROM application_native_field_contracts WHERE module_key='fixture-probe-module'")
   await client.query('DROP FUNCTION public.portable_probe_reader(uuid,jsonb,text,text)')
   // Erasure after export reaches the restore only through the anchored checkpoint.
   await erase(erasedAfterExport)
   const checkpoint=await restore.exportErasureCheckpoint({ownerClient:client,destination:join(stateDirectory!,'checkpoint.enc'),key,roster:reviewedRoster})
   expect(checkpoint.records).toBeGreaterThan(0)
   const oids=(await client.query(`SELECT $1::regprocedure::oid::text metadata,$2::regprocedure::oid::text catalog,'public.native_turn_helpers_current()'::regprocedure::oid::text root`,contractSlots)).rows[0]
   const state:State={sessions,actors,workspaces,observations,export:exported,moduleExport,checkpoint,erasedAfterExport,erasedBeforeExport,compiledRecordCount,contractModule,contractSlots,oids,families,harness}
   await writeFile(join(stateDirectory!,'state.json'),JSON.stringify(state),{mode:0o600})
  }finally{await client.end()}
 },300_000)
})

describe.skipIf(phase!=='target').sequential('[COMP:api/portable-restore] authenticated import into a fresh managed installation',()=>{
 const results:{name:string;passed:boolean;detail:string}[]=[]
 const state=async()=>JSON.parse(await readFile(join(stateDirectory!,'state.json'),'utf8')) as State
 const key=async()=>readFile(join(stateDirectory!,'key'))
 const archive=join(stateDirectory!,'archive')
 const tamperedCopy=async(name:string,edit:(manifest:Record<string,any>)=>void)=>{
  const directory=join(stateDirectory!,'tampered-'+name);await rm(directory,{recursive:true,force:true});await cp(archive,directory,{recursive:true})
  const scratch=join(stateDirectory!,'scratch-'+name);await mkdir(scratch,{recursive:true,mode:0o700})
  const manifest=await unsealJson(join(directory,'manifest.enc'),await key(),scratch);edit(manifest)
  await rm(join(directory,'manifest.enc'));await sealJson(manifest,join(directory,'manifest.enc'),await key())
  return{directory,anchor:sha(JSON.stringify(manifest))}
 }
 const refuses=async(name:string,code:string,run:()=>Promise<unknown>)=>{
  const client=await ownerClient()
  try{
   const before=(await client.query('SELECT count(*)::int n FROM sessions')).rows[0].n
   let error:any=null
   try{await run()}catch(caught){error=caught}
   expect(error?.code,String(error?.message)).toBe(code)
   expect((await client.query('SELECT count(*)::int n FROM sessions')).rows[0].n).toBe(before)
   results.push({name,passed:true,detail:String(error.message).slice(0,200)})
  }finally{await client.end()}
 }
 const importWith=async(options:Record<string,unknown>={})=>{
  const s=await state(),client=await ownerClient()
  try{return await restore.importPortableBrain({ownerClient:client,archiveDirectory:archive,key:await key(),expectedManifestSha256:s.export.manifestSha256,sourceRoot,roster:reviewedRoster,
   erasureCheckpoint:{path:join(stateDirectory!,'checkpoint.enc'),expectedSha256:s.checkpoint.checkpointSha256},...options})}
  finally{await client.end()}
 }

 it('authenticates the lineage display pin and inherited workspace MCP dispatch catalog',async()=>{
  await assertLocalFixture()
  const client=await ownerClient()
  try{
   const lineage='public.application_scope_lineage(uuid,text[],uuid[],text[])'
   const {rows:[display]}=await client.query<{fingerprint:string}>(
    'SELECT fingerprint FROM public.private_session_display_contract WHERE signature=$1',[lineage])
   if(!display)throw Error('Fixture lacks the application lineage display pin')
   await client.query('UPDATE public.private_session_display_contract SET fingerprint=$2 WHERE signature=$1',[lineage,'0'.repeat(64)])
   try{
    await expect(authenticateConversationInstallation(client,{sourceRoot})).rejects.toThrow('conversation_context_cost_display_pin_changed')
   }finally{
    await client.query('UPDATE public.private_session_display_contract SET fingerprint=$2 WHERE signature=$1',[lineage,display.fingerprint])
   }
   await client.query('ALTER TABLE public.workspace_mcp_runs DISABLE TRIGGER workspace_mcp_dispatch_sync')
   try{
    await expect(authenticateConversationInstallation(client,{sourceRoot})).rejects.toThrow('installation_additional_catalog_changed')
   }finally{
    await client.query('ALTER TABLE public.workspace_mcp_runs ENABLE TRIGGER workspace_mcp_dispatch_sync')
   }
  }finally{await client.end()}
 },300_000)

 it('refuses tampered, foreign, drifted and unknown inputs before any durable import',async()=>{
  await assertLocalFixture()
  const s=await state()
  // Byte-level tampering of one sealed table artifact.
  const flipped=join(stateDirectory!,'tampered-bytes');await rm(flipped,{recursive:true,force:true});await cp(archive,flipped,{recursive:true})
  const populated=(await readdir(join(flipped,'tables'))).sort()[0]
  const tableFile=join(flipped,'tables',populated),bytes=await readFile(tableFile);bytes[bytes.length-20]^=1;await writeFile(tableFile,bytes)
  await refuses('tampered-table-bytes','portable_restore_archive_untrusted',()=>importWith({archiveDirectory:flipped}))
  // A validly re-sealed but self-rehashed manifest fails the independent anchor.
  const rehashed=await tamperedCopy('self-rehashed',manifest=>{manifest.tables.find((table:{rows:number})=>table.rows>0).rows+=1})
  await refuses('self-rehashed-manifest','portable_restore_archive_untrusted',()=>importWith({archiveDirectory:rehashed.directory}))
  // Even with its own anchor, altered content does not match the sealed table.
  await refuses('reanchored-content-mismatch','portable_restore_archive_untrusted',()=>importWith({archiveDirectory:rehashed.directory,expectedManifestSha256:rehashed.anchor}))
  const foreign=await tamperedCopy('foreign-installation',manifest=>{manifest.installation.sourceDefinitionDigest='0'.repeat(64)})
  await refuses('wrong-installation-identity','portable_restore_installation_identity_mismatch',()=>importWith({archiveDirectory:foreign.directory,expectedManifestSha256:foreign.anchor}))
  const unknown=await tamperedCopy('unknown-archive-table',manifest=>{manifest.tables.push({...manifest.tables[0],name:'fictional_unreviewed_table'})})
  await refuses('unknown-archive-table','portable_restore_unknown_table',()=>importWith({archiveDirectory:unknown.directory,expectedManifestSha256:unknown.anchor}))
  await refuses('unshipped-regprocedure-module','portable_restore_schema_drift',()=>importWith({archiveDirectory:join(stateDirectory!,'module-archive'),expectedManifestSha256:s.moduleExport.manifestSha256}))
  const client=await ownerClient()
  try{
   if(await harnessInstalled()){
    const head=(await client.query('SELECT name FROM _migrations ORDER BY name COLLATE "C" DESC LIMIT 1')).rows[0].name
    const authenticatePinnedRelease=releaseAuthentication(head,sourceRoot)
    const snapshot=async()=>JSON.stringify({rows:await harnessRows(client),ledger:(await client.query('SELECT to_jsonb(t)::text row FROM _migrations t ORDER BY name')).rows,
     sessions:(await client.query('SELECT to_jsonb(t)::text row FROM sessions t ORDER BY id')).rows,
     catalog:(await client.query(`SELECT p.oid::text,pg_get_functiondef(p.oid) definition,p.proacl::text FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'project_harness_%' OR p.proname LIKE 'harness_execution_%') ORDER BY p.oid`)).rows,
     triggers:(await client.query(`SELECT t.oid::text,pg_get_triggerdef(t.oid) definition,t.tgenabled FROM pg_trigger t WHERE t.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'project_harness_%') ORDER BY t.oid`)).rows})
    const mutations=[
     ['function',`ALTER FUNCTION public.harness_execution_human(uuid,uuid) COST 101`,'portable_successor_catalog_changed'],
     ['acl',`GRANT EXECUTE ON FUNCTION public.harness_execution_human(uuid,uuid) TO app_user`,'portable_successor_catalog_changed'],
     ['trigger',`ALTER TABLE public.project_harness_runs DISABLE TRIGGER harness_run_audit`,'portable_successor_catalog_changed'],
     ['unknown-prefix',`CREATE FUNCTION public.harness_execution_unreviewed() RETURNS int LANGUAGE sql AS 'SELECT 1'`,'portable_successor_unknown_catalog_object'],
     ...(head==='8338_native_workspace_skill_receipts.sql'?[
      ['skill-receipt',`DELETE FROM public._migrations WHERE name='8338_native_workspace_skill_receipts.sql'`,'skill_scope_release_missing'],
     ]:[]),
     ...['8335_project_harnesses.sql','8336_project_harness_verification.sql','8337_project_chat_creation_admission.sql'].map(name=>['receipt:'+name,`DELETE FROM public._migrations WHERE name='${name}'`,'portable_successor_migration_tail_missing']),
    ]
    for(const [name,sql,error] of mutations){
     const before=await snapshot()
     await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
     try{
      await client.query(sql)
      // Preserve the caller's rollback boundary while exercising the real
      // source-owned authenticator, including its transaction cleanup.
      const owner={getTransactionStatus:()=> 'I',query:async(text:string,values?:unknown[])=>{
       if(text==='BEGIN ISOLATION LEVEL REPEATABLE READ')return client.query('SAVEPOINT authentication_probe')
       if(text==='COMMIT')return client.query('RELEASE SAVEPOINT authentication_probe')
       if(text==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT authentication_probe')
       return client.query(text,values)
      }}
      await expect(authenticatePinnedRelease(owner)).rejects.toThrow(error)
     }finally{await client.query('ROLLBACK')}
     expect(await snapshot()).toBe(before)
     results.push({name:head.slice(0,4)+'-authentication-'+name,passed:true,detail:error+'; transaction rolled back, state unchanged'})
    }
   }
   await client.query('CREATE TABLE public.fictional_unreviewed_target(id uuid PRIMARY KEY)')
   try{await refuses('unknown-target-table','portable_restore_unknown_table',()=>importWith())}
   finally{await client.query('DROP TABLE public.fictional_unreviewed_target')}
   await client.query('ALTER TABLE public.memory_recall_events ALTER COLUMN created_at TYPE timestamp without time zone')
   try{await refuses('column-type-drift','portable_restore_type_drift',()=>importWith())}
   finally{await client.query('ALTER TABLE public.memory_recall_events ALTER COLUMN created_at TYPE timestamp with time zone')}
  }finally{await client.end()}
  // A transaction-bound binding ahead of this cluster's counter never restores.
  const ahead=await tamperedCopy('transaction-horizon',manifest=>{manifest.transactionHorizon='9000000000000000'})
  await refuses('transaction-horizon-ahead','portable_restore_transaction_horizon_ahead',()=>importWith({archiveDirectory:ahead.directory,expectedManifestSha256:ahead.anchor}))
  const second=await ownerClient()
  try{
   await expect(restore.advanceTransactionHorizon(second,'9000000000000000')).rejects.toThrow('portable_restore_transaction_horizon_ahead')
   results.push({name:'transaction-horizon-unbounded-advance',passed:true,detail:'bounded advance refused'})
  }finally{await second.end()}
 },600_000)

 it('imports the exact durable roster, replays origin erasure, authenticates twice and passes ordinary-owner receiving before admission',async()=>{
  const s=await state(),client=await ownerClient()
  let receipt:any
  try{
   expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
   await restore.advanceTransactionHorizon(client,s.export.transactionHorizon)
   receipt=await importWith()
   expect(receipt.activation).toBe('withheld')
   expect(receipt.targetAuthentication).toHaveLength(2)
   expect(receipt.erasure.replayed).toBeGreaterThan(0)
   expect(receipt.reboundSlots).toEqual(expect.arrayContaining(s.contractSlots))
   // Rebound slots resolve to target-local function identities, not archived numbers.
   const slots=(await client.query("SELECT metadata_reader::text m,catalog_reader::text c,metadata_reader::oid::text mo FROM application_native_field_contracts WHERE module_key=$1",[s.contractModule])).rows[0]
   expect([slots.m,slots.c].map(value=>value.startsWith('public.')?value:'public.'+value)).toEqual(s.contractSlots)
   const targetOids=(await client.query(`SELECT $1::regprocedure::oid::text metadata,$2::regprocedure::oid::text catalog,'public.native_turn_helpers_current()'::regprocedure::oid::text root`,s.contractSlots)).rows[0]
   expect(slots.mo).toBe(targetOids.metadata)
   // The driver's target chain has different identifiers; template clones share them.
   if(process.env.BRIAN_PORTABLE_RESTORE_DISTINCT_OIDS==='1')for(const key of ['metadata','catalog','root'] as const)expect(targetOids[key]).not.toBe(s.oids[key])
   expect((await client.query('SELECT count(*)::int n FROM memories WHERE id=ANY($1::uuid[])',[[s.erasedAfterExport,s.erasedBeforeExport]])).rows[0].n).toBe(0)
   // Each conversation's 8277 completion header arrives exactly and stays committed for its old token.
   const completions=(await client.query('SELECT session_id,turn_token FROM native_turn_completions ORDER BY session_id')).rows
   expect(completions.map(row=>row.session_id).sort()).toEqual(s.sessions.map(session=>session.sessionId).sort())
   if(s.harness)await verifyHarnessHistory(s.harness,client)
   // Every seeded validator family arrives (record digests already proved each table exact).
   for(const row of s.families.rows)expect((await client.query(`SELECT count(*)::int n FROM public.${row.table} WHERE ${row.column}=$1`,[row.id])).rows[0].n,row.family+' '+row.table).toBe(row.count)
   // Regression: the 8063 lease stamp is suspended during import, so the archived last token survives.
   for(const session of s.sessions)expect((await client.query('SELECT last_turn_lease_token::text t FROM sessions WHERE id=$1',[session.sessionId])).rows[0].t).toBe(session.turnToken)
   for(const row of completions)expect((await client.query('SELECT read_native_turn_completion(workspace_id,id,$2,NULL)->>\'state\' state FROM sessions WHERE id=$1',[row.session_id,row.turn_token])).rows[0].state).toBe('committed')
   if(configuredTaskProof){
    const sealed=JSON.parse(await readFile(configuredTaskProof,'utf8')),evidence=sealed.evidence
    const incoming=(await client.query(`SELECT run_id,candidate_id,target_record_id,payload_hash,receipt_id,configured_txid,
     configured_backend_pid,configured_source,configured_task FROM episode_extraction_items WHERE run_id=$1 AND candidate_id=$2`,
     [evidence.run_id,evidence.candidate_id])).rows[0]
    expect(incoming).toEqual({...evidence,configured_txid:null,configured_backend_pid:null,configured_source:null,configured_task:null})
    const tasks=(await client.query('SELECT id,title,valid_to FROM tasks WHERE id=ANY($1::uuid[])',[[evidence.target_record_id,sealed.revisedId]])).rows
    expect(tasks.find(task=>task.id===evidence.target_record_id)).toMatchObject({title:evidence.configured_task.title,valid_to:expect.any(Date)})
    expect(tasks.find(task=>task.id===sealed.revisedId)).toMatchObject({title:'Ship the revised pricing page',valid_to:null})
    await expect(client.query(`INSERT INTO episode_extraction_items(run_id,candidate_id,primitive_kind,payload_hash,configured_txid,
     configured_backend_pid,configured_source,configured_task) VALUES($1,'fictional attempted seal','task',$2,pg_current_xact_id(),pg_backend_pid(),'{}','{}')`,
     [evidence.run_id,evidence.payload_hash])).rejects.toThrow('capture_receipt_not_caller_mintable')
   }
   if(s.compiledRecordCount){
    expect((await client.query("SELECT count(*)::int n FROM native_conversation_conversion_inputs WHERE kind::text='conversation_record'")).rows[0].n).toBe(0)
    expect((await client.query(`SELECT count(*)::int n FROM conversation_envelopes WHERE record_dirty_from=0
     AND num_nonnulls(record_conversion_generation,record_conversion_revision,record_conversion_through,record_conversion_legacy)=0`)).rows[0].n).toBeGreaterThanOrEqual(s.sessions.length)
    await client.query('SELECT enroll_existing_conversation_records(32)')
    for(let page=0;page<4;page++)await client.query('SELECT compile_conversation_record_page(32,4194304)')
    expect((await client.query("SELECT count(*)::int n FROM native_conversation_conversion_inputs WHERE kind::text='conversation_record'")).rows[0].n).toBeGreaterThan(0)
   }
   // Activation is withheld until a real receiving proof is admitted.
   await expect(restore.admitRestoredInstallation({ownerClient:client,importReceipt:receipt,receivingProof:{status:'passed',checks:[]}})).rejects.toThrow('portable_restore_activation_withheld')
  }finally{await client.end()}
  const checks:{name:string;passed:boolean}[]=configuredTaskProof?[{name:'configured-task-origin-seal-archive-and-cleared-import',passed:true}]:[]
  if(s.harness)checks.push({name:'8337-seven-table-exact-history-digests-audit-and-live-guards',passed:true})
  if(s.compiledRecordCount)checks.push({name:'compiled-record-copy-rederived',passed:true})
  const expected=s.observations
  const actual=await observe(s)
  for(const [key,value] of Object.entries(expected)){
   const observed=actual[key]
   if(key.startsWith('memories:')){
    // The post-export erasure is the only difference: replay removed it.
    const filtered={rows:(value.rows as {id:string}[]).filter(row=>row.id!==s.erasedAfterExport)}
    expect(observed).toEqual(filtered);checks.push({name:key,passed:true});continue
   }
   expect(observed).toEqual(value);checks.push({name:key,passed:true})
  }
  // Follow-up turn persistence through the restored runtime for each conversation.
  for(const session of s.sessions){
   const authority=await resolveSessionTitleAuthority({claims:session.ownerClaims,sessionId:session.sessionId,readOnly:false})
   const captured=await readAdmittedSessionQuery({sessionId:session.sessionId,throughSequence:session.through,authority})
   const replies=await publishNativeSessionMessageBatch({sessionId:session.sessionId,authority,
    derivationTarget:{workspaceId:session.workspaceId,userId:session.private?session.ownerClaims.userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]},
    derivation:{producer:'fixture:portable-restore',sources:boundScopeSources(captured)},
    messages:[{role:'assistant',senderAssistantId:session.assistantId,content:[{type:'text',text:'Continuing with the restored ledger.'}]}]})
   const reopened=await readAdmittedSessionQuery({sessionId:session.sessionId,throughSequence:replies[0].sequenceNum,
    authority:await resolveSessionTitleAuthority({claims:session.ownerClaims,sessionId:session.sessionId,readOnly:false})})
   expect(JSON.stringify(reopened.history)).toContain('Continuing with the restored ledger.')
   expect(JSON.stringify(reopened.history)).toContain('The ledger is cobalt.')
   checks.push({name:'follow-up:'+(session.private?'private':'shared'),passed:true})
  }
  const proof={status:'passed',importReceiptSha256:receipt.receiptSha256,checks}
  const admitClient=await ownerClient()
  try{
   const admission=await restore.admitRestoredInstallation({ownerClient:admitClient,importReceipt:receipt,receivingProof:proof})
   expect(admission.activation).toBe('admitted')
   await writeFile(join(stateDirectory!,'target-receipt.json'),JSON.stringify({importReceipt:receipt,receivingProof:proof,admission,refusals:results},null,2),{mode:0o600})
  }finally{await admitClient.end()}
 },600_000)

 it('refuses a repeated import into the now-populated installation without mutation',async()=>{
  await refuses('repeat-import-not-fresh','portable_restore_target_not_fresh',()=>importWith())
  const receiptPath=join(stateDirectory!,'target-receipt.json'),saved=JSON.parse(await readFile(receiptPath,'utf8'))
  saved.refusals=results;await writeFile(receiptPath,JSON.stringify(saved,null,2))
 },600_000)
})
