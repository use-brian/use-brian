// [COMP:platform/managed-postgres-transfer] Embedded (PGlite) source and release
// cohort for the existing-brain transfer into the managed runtime.
//
// Spec: docs/architecture/platform/portable-brain-restore.md, "Existing-brain
// transfer". A superuser-owned embedded brain cannot apply 8274 or later, so it
// is exported at the 8273 release cohort, imported into a managed instance at
// exactly that cohort, and only then moved forward by the shipped migration
// runner as the ordinary owner. This module never opens the user's brain
// directory itself: the caller passes a staged byte copy. The copy is served on a
// private Unix socket (0700 directory, one connection), so the unchanged
// node-postgres export path runs against it as the PGlite bootstrap owner.
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {currentInstallationAuthenticationSource as cohortAuthenticationSource} from './installation-authentication-8273.mjs'
import {loadPortableRoster,shippedMigrationSet,migrationLedgerAliases,PortableRestoreRefusal,exportPortableBrain,exportErasureCheckpoint} from './portable-restore.mjs'

const here=fileURLToPath(new URL('./',import.meta.url))
const sha=value=>createHash('sha256').update(value).digest('hex')
const refusal=(code,detail)=>new PortableRestoreRefusal(code,detail)

/**
 * The only embedded release cohort a transfer accepts. The roster is generated
 * and --check'ed by build-portable-restore-roster.mjs --cohort against a fresh
 * chain stopped at the cohort head (756 entries); it is pinned by digest so a
 * later head roster can never be applied to a cohort archive.
 */
export const embeddedTransferCohort=Object.freeze({
 through:'8273_conversation_requirement_conversion.sql',
 rosterFile:'portable-restore-roster-8273.json',
 rosterSha256:'871c15186e246c228646292dc9d52b974300a3e14dde5f4f650e317c4e79573b',
 functions:309,
 // PGlite 0.5.3 bundles pgvector 0.8.1; the managed artifact pins 0.8.7. Every
 // other fingerprint part must be identical, and rows cross as text through the
 // target's own input functions with exact digests.
 extensionTransitions:Object.freeze({vector:Object.freeze(['0.8.1','0.8.7'])}),
})

export async function loadCohortRoster(){
 const roster=await loadPortableRoster(here+embeddedTransferCohort.rosterFile)
 if(roster.digest!==embeddedTransferCohort.rosterSha256)throw refusal('portable_restore_roster_mismatch','cohort roster changed')
 return roster
}

/** The shipped cohort file set (every shipped migration through the cohort head). */
export async function cohortMigrationSet(options={}){
 return(await shippedMigrationSet(options)).filter(name=>name<=embeddedTransferCohort.through)
}

const roleBlock='DO $owner_roles$',roleBlockEnd='END $owner_roles$;'
async function authenticateCohort(client,{embedded}){
 if(client?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const engine=(await client.query("SELECT version() LIKE '%PGlite%' embedded")).rows[0].embedded
 if(engine!==embedded)throw refusal('portable_restore_source_profile_unknown',embedded?'embedded authentication on a native server':'cohort target is embedded')
 const source=await cohortAuthenticationSource()
 let sql=source.sql
 if(embedded){
  // The embedded owner is the engine superuser by construction, which the
  // runtime-role safety block refuses. That block guards a serving installation;
  // a staged read-only copy being exported never serves. Every catalog record
  // comparison after it runs unchanged.
  const end=sql.indexOf(roleBlockEnd)
  if(!sql.startsWith(roleBlock)||end<0||sql.indexOf(roleBlockEnd,end+1)!==-1)throw Error('embedded_authentication_source_changed')
  sql=sql.slice(end+roleBlockEnd.length)
 }
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await client.query(sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==embeddedTransferCohort.functions||!/^[a-f0-9]{64}$/.test(row.local_digest))throw Error('installation_authentication_receipt_malformed')
  await client.query(source.cleanup);await client.query('COMMIT')
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest})
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
}
/** 8273 source-compiled authentication of the staged embedded copy (role block omitted). */
export const authenticateEmbeddedSource=client=>authenticateCohort(client,{embedded:true})
/** Full 8273 source-compiled authentication of the managed target at the cohort. */
export const authenticateCohortTarget=client=>authenticateCohort(client,{embedded:false})

// The engine and extensions the embedded runtime itself uses (apps/api).
const apiRequire=createRequire(fileURLToPath(new URL('../../../../apps/api/package.json',import.meta.url)))
const pg=createRequire(fileURLToPath(new URL('../../package.json',import.meta.url)))('pg')
const load=specifier=>import(pathToFileURL(apiRequire.resolve(specifier)).href)

/**
 * Open a staged embedded copy, bring it to the cohort with the maintained
 * embedded runner if it is older, and serve it on a private Unix socket.
 * The ledger must be a prefix of the shipped cohort; anything else refuses.
 */
export async function openEmbeddedSource({directory,socketDirectory,sourceRoot}){
 const [{PGlite},{vector},{pg_trgm},{PGLiteSocketServer}]=await Promise.all([load('@electric-sql/pglite'),load('@electric-sql/pglite-pgvector'),
  load('@electric-sql/pglite/contrib/pg_trgm'),load('@electric-sql/pglite-socket')])
 const db=new PGlite(directory,{extensions:{vector,pg_trgm}})
 let server,migrated=0
 try{
  await db.waitReady
  const cohort=await cohortMigrationSet(sourceRoot?{sourceRoot}:{})
  const ledgerTable=(await db.query("SELECT to_regclass('public._migrations') IS NOT NULL present")).rows[0].present
  const ledger=ledgerTable?(await db.query('SELECT name FROM public._migrations ORDER BY name COLLATE "C"')).rows.map(row=>row.name):[]
  const shipped=new Set(cohort),applied=new Set(ledger)
  const aliases=await migrationLedgerAliases(sourceRoot)
  if(!ledger.length||ledger.some(name=>!shipped.has(name)&&!shipped.has(aliases.get(name))))
   throw refusal('portable_restore_source_not_at_shipped_head','embedded ledger is not a prefix of the shipped 8273 cohort')
  if(cohort.some(name=>!applied.has(name))){
   // Same runner and file set the embedded product boot applies, on the copy only.
   const {migratePglite}=await import(new URL('../../../../apps/api/src/migrate-pglite.ts',import.meta.url).href)
   migrated=await migratePglite(db,join(sourceRoot??fileURLToPath(new URL('../../',import.meta.url)),'migrations'),{through:embeddedTransferCohort.through})
  }
  server=new PGLiteSocketServer({db,path:join(socketDirectory,'.s.PGSQL.5432'),maxConnections:1})
  await server.start()
 }catch(error){await db.close().catch(()=>{});throw error}
 return{
  migrated,
  async connect(){
   const client=new pg.Client({host:socketDirectory,port:5432,user:'postgres',database:'postgres',application_name:'usebrian-transfer-source'})
   await client.connect();return client
  },
  async close(){await server.stop().catch(()=>{});await db.close()},
 }
}

/** Protected relations whose per-user visible set must match across the transfer. */
export const observedRelations=Object.freeze(['memories','sessions','session_messages','workspaces','workspace_members'])

/**
 * Per-user visible rows of each observed relation under the reviewed RLS
 * policies, as the restricted runtime role. On the embedded source the
 * superuser switches to app_user for the read; on the target the caller is an
 * app_user login. Digests use the canonical text settings of the archive.
 */
export async function protectedReadObservations(client,users,{embedded=false}={}){
 const result={}
 for(const user of users){
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try{
   // Runtime search path: policy helpers are resolved the way the product resolves them.
   await client.query(`SELECT set_config('search_path','public',true),set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true),
    set_config('IntervalStyle','postgres',true),set_config('extra_float_digits','1',true),set_config('bytea_output','hex',true),set_config('app.current_user_id',$1,true)`,[user])
   if(embedded)await client.query('SET LOCAL ROLE app_user')
   const role=(await client.query('SELECT current_user::text r')).rows[0].r
   if(role!=='app_user')throw Error('protected_read_requires_runtime_role')
   for(const relation of observedRelations){
    const row=(await client.query(`SELECT count(*)::int n,encode(sha256(convert_to(coalesce(string_agg(t::text,E'\\n' ORDER BY t::text COLLATE "C"),''),'UTF8')),'hex') d FROM public.${relation} t`)).rows[0]
    result[user+':'+relation]={rows:row.n,sha256:row.d}
   }
  }finally{await client.query('ROLLBACK').catch(()=>{})}
 }
 return result
}

/** Digest of the observation map (bound into the transfer control state). */
export const observationDigest=observations=>sha(JSON.stringify(Object.entries(observations).sort(([a],[b])=>a<b?-1:a>b?1:0)))

/** Conversations the receiving proof reopens (bounded; each with its starter). */
export async function receivingTargets(client,{limit=25}={}){
 return(await client.query(`SELECT s.id::text session_id,s.user_id::text actor FROM public.sessions s
  WHERE s.user_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.session_messages m WHERE m.session_id=s.id) ORDER BY s.id LIMIT $1`,[limit])).rows
  .map(row=>({sessionId:row.session_id,actorUserId:row.actor}))
}

/**
 * Export a staged embedded copy at the release cohort, as its own PGlite owner:
 * archive + erasure checkpoint (independent anchors returned to the caller, who
 * holds them outside the archive), and the source-side receiving observations.
 */
export async function exportEmbeddedBrain({sourceDirectory,archiveDirectory,checkpointPath,socketDirectory,key,sourceRoot}){
 const source=await openEmbeddedSource({directory:sourceDirectory,socketDirectory,sourceRoot})
 try{
  const client=await source.connect()
  try{
   const roster=await loadCohortRoster()
   let sourceAuthentication
   const exported=await exportPortableBrain({ownerClient:client,destination:archiveDirectory,key,sourceProfile:'embedded-superuser',roster,
    releaseThrough:embeddedTransferCohort.through,authenticate:async owner=>(sourceAuthentication=await authenticateEmbeddedSource(owner)),...(sourceRoot?{sourceRoot}:{})})
   const checkpoint=await exportErasureCheckpoint({ownerClient:client,destination:checkpointPath,key,sourceProfile:'embedded-superuser',roster})
   const users=(await client.query('SELECT id::text FROM public.users ORDER BY id')).rows.map(row=>row.id)
   const reads=await protectedReadObservations(client,users,{embedded:true})
   const observations={users,reads,sessions:await receivingTargets(client),migratedToCohort:source.migrated}
   return{manifestSha256:exported.manifestSha256,archiveId:exported.archiveId,checkpointSha256:checkpoint.checkpointSha256,records:checkpoint.records,
    release:{through:embeddedTransferCohort.through},sourceAuthentication,observations,observationsSha256:observationDigest(reads),
    export:{tables:exported.tables,rows:exported.rows,populatedTables:exported.populatedTables,transactionHorizon:exported.transactionHorizon}}
  }finally{await client.end()}
 }finally{await source.close()}
}
