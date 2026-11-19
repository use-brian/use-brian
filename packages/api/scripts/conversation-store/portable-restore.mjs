// [COMP:api/portable-restore] Finite portable brain export and authenticated restore.
//
// Contract (docs/architecture/platform/database-schema.md, "Portable brain
// restore contract"): the target is a fresh managed installation whose schema
// was produced by the shipped migrations. Archive data never carries DDL. The
// import verifies the shipped head, authenticates the installation, imports the
// reviewed durable roster under canonical constraints, rebinds named
// regprocedure slots only through the authenticated target catalog, replays the
// origin erasure journal with every trigger enabled, authenticates again and
// leaves activation withheld until a real receiving proof is admitted.
import {createHash,randomBytes} from 'node:crypto'
import {createReadStream,createWriteStream} from 'node:fs'
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createInterface} from 'node:readline'
import {fileURLToPath} from 'node:url'
import {once} from 'node:events'
import {sealFile,unsealFile,sealJson,unsealJson,newDirectory,atomicJson,digestFile} from '../../../../scripts/operations/recovery-common.mjs'
import {authenticateConversationInstallation as authenticateRestoredHead,hasInstallationRelease,releaseAuthentication} from './installation-release.mjs'
import {executableRegistryProofSql,compareExecutableRegistryRosters} from './executable-record.mjs'
import {portableLegacyConversionPredicate,portableLegacyConversionTables,portableOwnerPolicies,restoreStrippedFields} from './portable-restore-seals.mjs'

import {
 crmSummaryCredentialRule,crmSummaryPortable,crmSummaryProjectionRule,exportCrmSummaryCredentials,installCrmSummaryCredentials,
 readCrmSummaryCredentials,rebuildCrmSummaryProjections,
} from './crm-summary-portable.mjs'

export const portableArchiveFormat='use-brian-portable-brain-v1'
const here=fileURLToPath(new URL('./',import.meta.url))
const defaultSourceRoot=fileURLToPath(new URL('../../',import.meta.url))
const sha=value=>createHash('sha256').update(value).digest('hex')
const ident=name=>{if(typeof name!=='string'||!/^[a-z_][a-z0-9_]*$/.test(name))throw refusal('portable_restore_unsafe_identifier',String(name));return '"'+name+'"'}
const lit=value=>"'"+String(value).replaceAll("'","''")+"'"
// Embedded (PGlite) source sessions. The engine's bootstrap superuser owns the
// brain and bypasses row security, so actor partitions are read as the
// restricted runtime role under the reviewed policy (existing-brain transfer).
const embeddedSources=new WeakSet()

/** Every refusal is a typed, actionable error; the target stays quarantined. */
export class PortableRestoreRefusal extends Error{
 constructor(code,detail){super(detail?code+': '+detail:code);this.code=code;this.detail=detail}
}
const refusal=(code,detail)=>new PortableRestoreRefusal(code,detail)

function reviewedReleaseAuthentication(head,sourceRoot){
 if(!hasInstallationRelease(head))throw refusal('portable_restore_unreviewed_installation_release',head)
 return releaseAuthentication(head,sourceRoot)
}

export async function loadPortableRoster(path=here+'portable-restore-roster.json'){
 const text=await readFile(path,'utf8'),roster=JSON.parse(text)
 if(roster?.format!==1||!roster.tables||!roster.triggers||!roster.sequences||!Array.isArray(roster.deferredReferences))throw refusal('portable_restore_roster_malformed')
 for(const [name,entry] of Object.entries(roster.tables)){
  ident(name)
  if(!['durable','derived','rebound','rederived'].includes(entry.class)||!roster.rules[entry.rule])throw refusal('portable_restore_roster_malformed',name)
  if(entry.stripOnTransfer!==undefined&&(entry.class!=='durable'||entry.forceRls||
   JSON.stringify(entry.stripOnTransfer)!==JSON.stringify(Object.keys(restoreStrippedFields[name]??{}))||!entry.stripOnTransfer.length||
   entry.transactionBound?.some(column=>entry.stripOnTransfer.includes(column))))throw refusal('portable_restore_roster_malformed',name+' transfer seal')
 }
 const compiled=roster.tables.conversation_envelopes?.stripOnTransfer!==undefined
 if(Object.entries(roster.tables).some(([name,entry])=>Boolean(entry.excludeCompiledRecords)!==(compiled&&portableLegacyConversionTables.includes(name))))
  throw refusal('portable_restore_roster_malformed','compiled conversation projection')
 if(roster.validatorOrder!==undefined&&(!Array.isArray(roster.validatorOrder)||roster.validatorOrder.some(item=>!roster.tables[item?.table]||!Array.isArray(item.reads)||item.reads.some(read=>!roster.tables[read]))))
  throw refusal('portable_restore_roster_malformed','validator order')
 return Object.freeze({...roster,digest:sha(text)})
}

/** Shipped migration file set: the trusted head the target must be at. */
export async function shippedMigrationSet({sourceRoot=defaultSourceRoot,migrationDirs=[]}={}){
 const names=[]
 for(const dir of [join(sourceRoot,'migrations'),...migrationDirs])for(const name of await readdir(dir))if(name.endsWith('.sql'))names.push(name)
 if(new Set(names).size!==names.length)throw refusal('portable_restore_shipped_migrations_duplicate')
 return names.sort()
}
// Released rename aliases recorded by the migration runner (src/migrations/renames.ts).
async function ledgerAliases(sourceRoot){
 const source=await readFile(join(sourceRoot,'src/migrations/renames.ts'),'utf8')
 return new Map([...source.matchAll(/\['([\w.-]+\.sql)',\s*'([\w.-]+\.sql)'\]/g)].map(match=>[match[1],match[2]]))
}
function compatibleLedger(ledger,shipped,aliases){
 const set=new Set(shipped)
 if(!shipped.every(name=>ledger.includes(name)))return false
 return ledger.every(name=>set.has(name)||set.has(aliases.get(name)))
}

async function requireOrdinaryOwner(client){
 if(client?.getTransactionStatus?.()!=='I')throw refusal('portable_restore_requires_idle_owner')
 const role=(await client.query(`SELECT r.rolsuper,r.rolbypassrls,c.relowner=r.oid owns FROM pg_roles r,pg_class c
  WHERE r.rolname=current_user AND c.oid='public.sessions'::regclass`)).rows[0]
 if(!role||role.rolsuper||role.rolbypassrls||!role.owns)throw refusal('portable_restore_requires_ordinary_owner')
}
/** Source owner check. 'embedded-superuser' admits only a PGlite brain owned by its bootstrap superuser. */
async function requireSourceOwner(client,sourceProfile){
 if(sourceProfile===undefined||sourceProfile==='ordinary-owner')return requireOrdinaryOwner(client)
 if(sourceProfile!=='embedded-superuser')throw refusal('portable_restore_source_profile_unknown',String(sourceProfile))
 if(client?.getTransactionStatus?.()!=='I')throw refusal('portable_restore_requires_idle_owner')
 const role=(await client.query(`SELECT r.rolsuper,c.relowner=r.oid owns,version() LIKE '%PGlite%' embedded,
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit) runtime
  FROM pg_roles r,pg_class c WHERE r.rolname=current_user AND c.oid='public.sessions'::regclass`)).rows[0]
 if(!role?.rolsuper||!role.owns||!role.embedded||!role.runtime)throw refusal('portable_restore_requires_embedded_owner')
 embeddedSources.add(client)
}
/** Shipped migration set, optionally restricted to the release cohort ending at releaseThrough. */
async function releaseSet({sourceRoot,migrationDirs,releaseThrough}){
 const shipped=await shippedMigrationSet({sourceRoot,migrationDirs})
 if(releaseThrough===undefined)return shipped
 if(!shipped.includes(releaseThrough))throw refusal('portable_restore_release_unknown',String(releaseThrough))
 return shipped.filter(name=>name<=releaseThrough)
}
// Fixed, server-independent text forms. Export renders reg* values schema-qualified.
async function canonicalSession(client,{qualify}){
 await client.query(`SELECT set_config('search_path',$1,true),set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true),
  set_config('IntervalStyle','postgres',true),set_config('extra_float_digits','1',true),set_config('bytea_output','hex',true),
  set_config('row_security','off',true),set_config('app.crm_erasure_capture','off',true),set_config('app.system_bypass','',true),
  set_config('app.current_user_id','00000000-0000-0000-0000-000000000000',true)`,[qualify?'pg_catalog':'public'])
}
const qualified=client=>client.query("SELECT set_config('search_path','pg_catalog',true)")
const unqualified=client=>client.query("SELECT set_config('search_path','public',true)")

/** Metadata-only, OID-free schema fingerprint of the trusted shipped schema. */
export async function schemaFingerprint(client){
 await qualified(client)
 const rows=async sql=>(await client.query(sql)).rows
 const columns=await rows(`SELECT c.relname tab,array_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,a.attidentity,
   pg_get_expr(d.adbin,d.adrelid),co.collname) ORDER BY a.attnum) cols
  FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation AND a.attcollation<>0
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') GROUP BY c.relname ORDER BY c.relname COLLATE "C"`)
 const parts={
  relations:await rows(`SELECT relname,relkind,relpersistence,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace
   AND relkind IN('r','p','v','m','S','f') ORDER BY relname COLLATE "C"`),
  constraints:await rows(`SELECT t.relname,k.conname,k.contype,k.condeferrable,k.condeferred,k.convalidated,pg_get_constraintdef(k.oid) def FROM pg_constraint k
   JOIN pg_class t ON t.oid=k.conrelid WHERE t.relnamespace='public'::regnamespace ORDER BY t.relname COLLATE "C",k.conname COLLATE "C"`),
  indexes:await rows(`SELECT indexname,indexdef def FROM pg_indexes WHERE schemaname='public' ORDER BY indexname COLLATE "C"`),
  triggers:await rows(`SELECT c.relname,t.tgname,t.tgtype,t.tgenabled,t.tgfoid::regprocedure::text fn,encode(t.tgargs,'hex') args,t.tgattr::text attr,
   t.tgdeferrable,t.tginitdeferred FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C"`),
  policies:await rows(`SELECT p.tablename,p.policyname,p.permissive,
   ARRAY(SELECT CASE WHEN role=pg_get_userbyid(c.relowner) THEN '_relation_owner_' ELSE role::text END FROM unnest(p.roles) role)::text roles,
   p.cmd,p.qual,p.with_check FROM pg_policies p JOIN pg_class c ON c.relnamespace='public'::regnamespace AND c.relname=p.tablename
   WHERE p.schemaname='public'
   ORDER BY tablename COLLATE "C",policyname COLLATE "C"`),
  // Bodies carry installation-local pins; the installation authenticator owns them.
  routines:await rows(`SELECT p.oid::regprocedure::text sig,p.prokind,p.prosecdef,p.provolatile,p.proretset,p.prorettype::regtype::text ret,l.lanname
   FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.pronamespace='public'::regnamespace
   AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') ORDER BY p.oid::regprocedure::text COLLATE "C"`),
  types:await rows(`SELECT t.typname,t.typtype,(SELECT array_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) FROM pg_attribute a
   WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped) attrs,(SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid) labels
   FROM pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typtype IN('c','e','d')
   AND (t.typrelid=0 OR (SELECT relkind FROM pg_class WHERE oid=t.typrelid)='c') ORDER BY t.typname COLLATE "C"`),
  sequences:await rows(`SELECT sequencename,data_type::text,start_value,increment_by,max_value,min_value,cycle FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename COLLATE "C"`),
  extensions:await rows(`SELECT extname,extversion FROM pg_extension ORDER BY extname COLLATE "C"`),
 }
 await unqualified(client)
 const tables=Object.fromEntries(columns.map(row=>[row.tab,row.cols]))
 // Extension versions are kept in clear so a reviewed engine transition can be named.
 return{digest:sha(JSON.stringify({tables,...parts})),tables,partDigests:Object.fromEntries(Object.entries(parts).map(([key,value])=>[key,sha(JSON.stringify(value))])),extensions:parts.extensions}
}
function compareFingerprints(source,target){
 if(source.digest===target.digest)return
 for(const [table,columns] of Object.entries(source.tables)){
  const actual=target.tables[table]
  if(!actual)throw refusal('portable_restore_schema_drift','missing table '+table)
  for(const column of columns){
   const match=actual.find(other=>other[0]===column[0])
   if(!match)throw refusal('portable_restore_type_drift',table+'.'+column[0]+' missing')
   if(JSON.stringify(match)!==JSON.stringify(column))throw refusal('portable_restore_type_drift',table+'.'+column[0]+' '+column[1]+' -> '+match[1])
  }
  if(actual.length!==columns.length)throw refusal('portable_restore_type_drift',table+' column set')
 }
 for(const table of Object.keys(target.tables))if(!source.tables[table])throw refusal('portable_restore_unknown_table',table)
 const parts=Object.keys(source.partDigests).filter(key=>source.partDigests[key]!==target.partDigests[key])
 throw refusal('portable_restore_schema_drift',parts.join(','))
}

/**
 * Cross-engine comparison (existing-brain transfer). Every fingerprint part must
 * be identical except extension versions, which may differ only by an exact
 * reviewed transition (source version -> target version). Returns the transitions used.
 */
function compareEngineFingerprints(source,target,transitions){
 if(!transitions){compareFingerprints(source,target);return[]}
 if(!Array.isArray(source.extensions)||!Array.isArray(target.extensions))throw refusal('portable_restore_schema_drift','extensions unrecorded')
 if(source.extensions.map(e=>e.extname).join(',')!==target.extensions.map(e=>e.extname).join(','))throw refusal('portable_restore_schema_drift','extensions')
 const used=[]
 source.extensions.forEach((extension,index)=>{
  const actual=target.extensions[index].extversion
  if(extension.extversion===actual)return
  const pair=transitions[extension.extname]
  if(!Array.isArray(pair)||pair[0]!==extension.extversion||pair[1]!==actual)throw refusal('portable_restore_schema_drift','extension '+extension.extname+' '+extension.extversion+' -> '+actual)
  used.push(extension.extname+' '+pair[0]+' -> '+pair[1])
 })
 const reviewed=fingerprint=>{const partDigests={...fingerprint.partDigests,extensions:'reviewed-transition'}
  return{tables:fingerprint.tables,partDigests,digest:sha(JSON.stringify({tables:fingerprint.tables,partDigests}))}}
 compareFingerprints(reviewed(source),reviewed(target))
 return used
}

/** Every public table must be classified by the reviewed roster; unknown refuses. */
export async function verifyCatalogRoster(client,roster){
 const catalog=(await client.query(`SELECT c.relname,c.relforcerowsecurity force_rls FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') ORDER BY 1`)).rows
 for(const row of catalog){
  const entry=roster.tables[row.relname]
  if(!entry)throw refusal('portable_restore_unknown_table',row.relname)
  if(Boolean(entry.forceRls)!==row.force_rls)throw refusal('portable_restore_unreviewed_policy',row.relname)
 }
 const names=new Set(catalog.map(row=>row.relname))
 for(const name of Object.keys(roster.tables))if(!names.has(name))throw refusal('portable_restore_roster_table_missing',name)
 for(const [table,seals] of Object.entries(restoreStrippedFields)){
  if(!names.has(table))continue
  const present=(await client.query(`SELECT attname,format_type(atttypid,atttypmod) type,
    NOT attnotnull AND NOT atthasdef AND attgenerated='' AND attidentity='' transferable
    FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attname=ANY($2)`,
    ['public.'+table,Object.keys(seals)])).rows
  if(present.length&&(present.length!==Object.keys(seals).length||
   present.some(column=>seals[column.attname]!==column.type||column.transferable!==true)||
   JSON.stringify(roster.tables[table]?.stripOnTransfer)!==JSON.stringify(Object.keys(seals))))
   throw refusal('portable_restore_ephemeral_seal_shape_changed',table)
  if(!present.length&&roster.tables[table]?.stripOnTransfer)throw refusal('portable_restore_ephemeral_seal_shape_changed',table)
 }
 const sequences=(await client.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S' ORDER BY 1")).rows.map(row=>row.relname)
 if(JSON.stringify(sequences.sort())!==JSON.stringify(Object.keys(roster.sequences).sort()))throw refusal('portable_restore_unknown_sequence',sequences.join(','))
 await qualified(client)
 const triggers=(await client.query(`SELECT c.relname,t.tgname,t.tgtype,t.tgenabled,t.tgfoid::regprocedure::text fn FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND (t.tgtype & 4<>0 OR t.tgtype & 16<>0)`)).rows
 await unqualified(client)
 const seen=new Set()
 for(const row of triggers){
  if(['derived','rederived'].includes(roster.tables[row.relname].class))continue
  const key=row.relname+'.'+row.tgname,entry=roster.triggers[key]
  if(!entry||entry.tgtype!==row.tgtype||entry.function.replace(/^public\./,'')!==row.fn.replace(/^public\./,''))throw refusal('portable_restore_unreviewed_trigger',key)
  if(row.tgenabled!=='O')throw refusal('portable_restore_trigger_state',key+'='+row.tgenabled)
  seen.add(key)
 }
 for(const key of Object.keys(roster.triggers))if(!seen.has(key))throw refusal('portable_restore_roster_trigger_missing',key)
 const policies=(await client.query(`SELECT p.tablename,p.policyname,p.cmd,p.qual,p.with_check,
  p.roles=ARRAY[pg_get_userbyid(c.relowner)]::name[] AND p.permissive='PERMISSIVE' owner_policy
  FROM pg_policies p JOIN pg_class c ON c.relnamespace='public'::regnamespace AND c.relname=p.tablename
  WHERE p.schemaname='public' AND c.relforcerowsecurity ORDER BY p.tablename COLLATE "C",p.policyname COLLATE "C"`)).rows
 for(const [name,entry] of Object.entries(roster.tables))if(entry.forceRls){
  const digest=sha(JSON.stringify(policies.filter(policy=>policy.tablename===name).map(({policyname,cmd,qual,with_check})=>[policyname,cmd,qual,with_check])))
  if(digest!==entry.forceRls.policyDigest)throw refusal('portable_restore_unreviewed_policy',name)
  if(entry.forceRls.access==='owner'&&(entry.forceRls.policy!==portableOwnerPolicies[name]||!policies.some(policy=>
   policy.tablename===name&&policy.policyname===entry.forceRls.policy&&policy.owner_policy&&policy.cmd==='ALL'&&policy.qual==='true'&&policy.with_check==='true')))
   throw refusal('portable_restore_unreviewed_policy',name)
  for(const constraint of entry.forceRls.coverage??[]){
   const valid=(await client.query("SELECT convalidated FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2 AND contype='f'",['public.'+name,constraint])).rows[0]
   if(!valid?.convalidated)throw refusal('portable_restore_actor_coverage_unproved',name+'.'+constraint)
  }
 }
 return{tables:catalog.length,triggers:triggers.length}
}

// Access paths for FORCE-RLS tables; everything else is read by the owner with
// row_security=off so an unexpected policy raises instead of filtering.
// The nil UUID is the canonical reverted actor sentinel (see client.ts).
const nilActor='00000000-0000-0000-0000-000000000000'
async function withAccess(client,entry,actor,run){
 if(!entry.forceRls)return run()
 if(entry.forceRls.access==='owner')await client.query("SELECT set_config('row_security','on',true)")
 else if(entry.forceRls.access==='system')await client.query("SELECT set_config('row_security','on',true),set_config('app.system_bypass','true',true),set_config('app.current_user_id',$1,true)",[nilActor])
 else if(actor)await client.query("SELECT set_config('row_security','on',true),set_config('app.system_bypass','',true),set_config('app.current_user_id',$1,true)",[actor])
 else throw refusal('portable_restore_actor_required')
 // A superuser bypasses every policy: evaluate the actor policy as the runtime role.
 const embedded=entry.forceRls.access==='actor'&&embeddedSources.has(client)
 if(embedded)await client.query('SET LOCAL ROLE app_user')
 try{return await run()}finally{if(embedded)await client.query('RESET ROLE');await client.query("SELECT set_config('row_security','off',true),set_config('app.system_bypass','',true),set_config('app.current_user_id',$1,true)",[nilActor])}
}
async function actorIds(client){return(await client.query('SELECT id::text FROM public.users ORDER BY id')).rows.map(row=>row.id)}

/** Stream one table's canonical record texts, ordered by C collation. */
async function readTable(client,name,entry,onRow,{archive=false}={}){
 let row='t'
 if(entry.stripOnTransfer){
  const {columns}=await tableShape(client,name)
  const values=columns.map(column=>entry.stripOnTransfer.includes(column.name)?'NULL':
   name==='conversation_envelopes'&&column.name==='record_dirty_from'?'0':'t.'+ident(column.name))
  row=`(ROW(${values.join(',')})::public.${ident(name)})`
 }
 const archived=archive&&name==='episode_extraction_items'&&entry.stripOnTransfer?',t::text original':''
 const filtered=entry.excludeCompiledRecords?' WHERE '+portableLegacyConversionPredicate(name,column=>'t.'+ident(column)):''
 const select=`SELECT ${row}::text r${archived} FROM public.${ident(name)} t${filtered} ORDER BY ${row}::text COLLATE "C"`
 const scan=async actor=>{
  await client.query(`DECLARE portable_scan NO SCROLL CURSOR FOR ${select}`)
  try{for(;;){const rows=(await client.query('FETCH FORWARD 500 FROM portable_scan')).rows;if(!rows.length)break;for(const row of rows)await onRow(row.r,actor,row.original??row.r)}}
  finally{await client.query('CLOSE portable_scan')}
 }
 await qualified(client)
 try{
  // Actor partitions are complete by schema: every row has a validated NOT NULL
  // reference to a user (roster coverage constraints, verified per import).
  if(entry.forceRls?.access==='actor')for(const actor of await actorIds(client))await withAccess(client,entry,actor,()=>scan(actor))
  else await withAccess(client,entry,null,()=>scan(null))
 }finally{await unqualified(client)}
}

async function tableDigest(client,name,entry){
 const hash=createHash('sha256');let rows=0;const actors=new Map(),seen=new Set()
 const lines=[]
 await readTable(client,name,entry,(text,actor)=>{
  if(entry.forceRls?.access==='actor'){if(seen.has(text))throw refusal('portable_restore_actor_partition_overlap',name);seen.add(text);lines.push(text);actors.set(text,actor)}
  else{hash.update(text+'\n');rows++}
 })
 if(entry.forceRls?.access==='actor'){lines.sort((a,b)=>a<b?-1:a>b?1:0);for(const text of lines)hash.update(text+'\n');rows=lines.length}
 // The embedded owner sees every row: the actor partitions must cover all of them.
 if(entry.forceRls?.access==='actor'&&embeddedSources.has(client)&&(await client.query(`SELECT count(*)::int n FROM public.${ident(name)}`)).rows[0].n!==rows)
  throw refusal('portable_restore_actor_partition_incomplete',name)
 return{rows,sha256:hash.digest('hex'),actors}
}

/**
 * Per-table row counts and record digests in the archive's canonical form (one
 * read-only snapshot, the export's session settings and access paths). Used to
 * compare a source and a restored target table by table; it never writes.
 */
export async function portableTableDigests({ownerClient:client,roster,sourceProfile}){
 await requireSourceOwner(client,sourceProfile)
 const digests={}
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
 try{
  await canonicalSession(client,{qualify:false})
  await verifyCatalogRoster(client,roster)
  for(const [name,entry] of Object.entries(roster.tables).sort(([a],[b])=>a<b?-1:1)){
   const proof=await tableDigest(client,name,entry)
   digests[name]={class:entry.class,rows:proof.rows,sha256:proof.sha256}
  }
  await client.query('COMMIT')
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
 return digests
}

async function transactionHorizon(client,roster){
 let max=0n
 for(const [name,entry] of Object.entries(roster.tables))for(const column of entry.transactionBound??[]){
  const value=(await withAccess(client,entry,null,()=>client.query(`SELECT max(${ident(column)}::text::numeric)::text v FROM public.${ident(name)}`))).rows[0].v
  if(value!==null&&BigInt(value)>max)max=BigInt(value)
 }
 return max.toString()
}

/** Advance this cluster's transaction counter so no restored binding is in its future. */
export async function advanceTransactionHorizon(client,horizon,{maxGap=5_000_000}={}){
 const target=BigInt(horizon)
 let current=BigInt((await client.query('SELECT pg_current_xact_id()::text v')).rows[0].v)
 if(target-current>BigInt(maxGap))throw refusal('portable_restore_transaction_horizon_ahead','gap exceeds '+maxGap)
 while(current<=target)current=BigInt((await client.query('SELECT pg_current_xact_id()::text v')).rows[0].v)
 return current.toString()
}

async function writeLines(path,iterate){
 const stream=createWriteStream(path,{flags:'wx',mode:0o600}),hash=createHash('sha256');let rows=0
 await iterate(async line=>{hash.update(line+'\n');rows++;if(!stream.write(line+'\n'))await once(stream,'drain')})
 stream.end();await once(stream,'finish')
 return{rows,sha256:hash.digest('hex')}
}

/**
 * Export a source brain as an encrypted portable archive. The returned
 * manifestSha256 is the independent trust anchor the importer requires.
 */
export async function exportPortableBrain({ownerClient:client,destination,key,sourceRoot=defaultSourceRoot,migrationDirs=[],
 sourceProfile,roster:reviewedRoster,releaseThrough,authenticate}){
 if(!Buffer.isBuffer(key)||key.length!==32)throw refusal('portable_restore_key_required')
 await requireSourceOwner(client,sourceProfile)
 const roster=reviewedRoster??await loadPortableRoster(),shipped=await releaseSet({sourceRoot,migrationDirs,releaseThrough})
 const installation=await (authenticate??reviewedReleaseAuthentication(shipped.at(-1),sourceRoot))(client)
 const directory=await newDirectory(destination),work=await mkdtemp(join(tmpdir(),'portable-export-'))
 await mkdir(join(directory,'tables'),{mode:0o700})
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try{
   await canonicalSession(client,{qualify:false})
   await verifyCatalogRoster(client,roster)
   const ledger=(await client.query('SELECT name FROM public._migrations ORDER BY name COLLATE "C"')).rows.map(row=>row.name)
   if(!compatibleLedger(ledger,shipped,await ledgerAliases(sourceRoot)))throw refusal('portable_restore_source_not_at_shipped_head')
   const fingerprint=await schemaFingerprint(client)
   // Original proofs of installation-derived tables: retained, never imported.
   const derived={}
   for(const [name,entry] of Object.entries(roster.tables))if(entry.class==='derived'){
    if(entry.rule===crmSummaryCredentialRule)continue
    const proof=await tableDigest(client,name,entry)
    if(entry.rule==='D8-transaction-scratch'&&proof.rows!==0)throw refusal('portable_restore_origin_scratch_not_empty',name)
    derived[name]={rows:proof.rows,sha256:proof.sha256}
   }
   derived.native_turn_contract_helpers.records=(await client.query(executableRegistryProofSql)).rows
   derived.native_retained_contract_helpers.signatures=(await client.query('SELECT signature FROM public.native_retained_contract_helpers ORDER BY signature COLLATE "C"')).rows.map(row=>row.signature)
   derived.private_session_display_contract.signatures=(await client.query('SELECT signature FROM public.private_session_display_contract ORDER BY signature COLLATE "C"')).rows.map(row=>row.signature)
   derived.crm_erasure_journal_targets.rows_text=[]
   await readTable(client,'crm_erasure_journal_targets',roster.tables.crm_erasure_journal_targets,text=>{derived.crm_erasure_journal_targets.rows_text.push(text)})
   const tables=[]
   let index=0
   for(const [name,entry] of Object.entries(roster.tables).sort(([a],[b])=>a<b?-1:1)){
    if(entry.class==='derived')continue
    const file=String(index++).padStart(4,'0')+'.rows',plain=join(work,file)
    let result
    if(entry.forceRls?.access==='actor'){
     const proof=await tableDigest(client,name,entry)
     const lines=[...proof.actors.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)
     result=await writeLines(plain,async write=>{for(const [text,actor] of lines)await write(JSON.stringify([actor,text]))})
     result.recordSha256=proof.sha256
    }else{
     const hash=createHash('sha256')
     result=await writeLines(plain,async write=>{
      await readTable(client,name,entry,async (semantic,_actor,archival)=>{
       hash.update(semantic+'\n');await write(JSON.stringify(archival))
      },{archive:true})
     })
     result.recordSha256=hash.digest('hex')
    }
    // Empty tables carry no artifact (an empty sealed stream is not a supported
    // recovery artifact); their empty digests are still bound by the manifest.
    if(result.rows)await sealFile(plain,join(directory,'tables',file+'.enc'),key)
    await rm(plain)
    tables.push({name,file:result.rows?'tables/'+file+'.enc':null,rows:result.rows,lineSha256:result.sha256,recordSha256:result.recordSha256})
   }
   const sequences={}
   for(const name of Object.keys(roster.sequences)){
    const row=(await client.query(`SELECT last_value::text,is_called FROM public.${ident(name)}`)).rows[0]
    sequences[name]={lastValue:row.last_value,isCalled:row.is_called}
   }
   const horizon=await transactionHorizon(client,roster)
   const crmCredentials=crmSummaryPortable(roster)?await exportCrmSummaryCredentials(client,directory,key):null
   await client.query('COMMIT')
   const derivedArtifact=await sealJson(derived,join(directory,'derived.enc'),key)
   const manifest={format:portableArchiveFormat,createdAt:new Date().toISOString(),archiveId:randomBytes(16).toString('hex'),
    sourceProfile:sourceProfile??'ordinary-owner',...(releaseThrough?{release:{through:releaseThrough}}:{}),
    roster:{digest:roster.digest,counts:roster.counts},shipped:{migrations:shipped.length,sha256:sha(shipped.join('\n'))},ledger,
    installation:{format:installation.format,sourceDefinitionDigest:installation.sourceDefinitionDigest,functions:installation.functions,localContractDigest:installation.localContractDigest},
    ...(crmCredentials?{credentials:{crmSummary:crmCredentials}}:{}),
    fingerprint,derived:{file:'derived.enc',sha256:derivedArtifact.sha256},tables,sequences,transactionHorizon:horizon}
   const manifestText=JSON.stringify(manifest)
   await sealJson(manifest,join(directory,'manifest.enc'),key)
   const receipt={schema:'portable-brain-export-receipt-v1',status:'exported',manifestSha256:sha(manifestText),archiveId:manifest.archiveId,
    tables:tables.length,rows:tables.reduce((n,t)=>n+t.rows,0),populatedTables:tables.filter(t=>t.rows).length,transactionHorizon:horizon}
   await atomicJson(join(directory,'receipt.json'),receipt)
   return receipt
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
 }finally{await rm(work,{recursive:true,force:true})}
}

/** Export the source's current erasure journal as an anchored checkpoint. */
export async function exportErasureCheckpoint({ownerClient:client,destination,key,sourceProfile,roster:reviewedRoster}){
 await requireSourceOwner(client,sourceProfile)
 const roster=reviewedRoster??await loadPortableRoster()
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
 try{
  await canonicalSession(client,{qualify:false})
  const records=[]
  await qualified(client)
  for(const row of (await client.query('SELECT t::text r FROM public.crm_erasure_journal t ORDER BY sequence')).rows)records.push(row.r)
  await unqualified(client)
  await client.query('COMMIT')
  const checkpoint={format:'use-brian-portable-erasure-checkpoint-v1',rosterDigest:roster.digest,capturedAt:new Date().toISOString(),records}
  await sealJson(checkpoint,destination,key)
  return{checkpointSha256:sha(JSON.stringify(checkpoint)),records:records.length}
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
}

async function readArchiveJson(path,key,expectedSha,scratch,code){
 let value
 try{value=await unsealJson(path,key,scratch)}catch{throw refusal(code,'authentication failed')}
 if(expectedSha!==undefined&&sha(JSON.stringify(value))!==expectedSha)throw refusal(code,'independent anchor mismatch')
 return value
}

/** Authenticate every artifact before any target mutation; returns private plaintext paths. */
async function authenticateArchive(archiveDirectory,manifest,key,scratch){
 if(!/^derived\.enc$/.test(manifest.derived?.file??'')||await digestFile(join(archiveDirectory,manifest.derived.file)).catch(()=>null)!==manifest.derived.sha256)
  throw refusal('portable_restore_archive_untrusted','derived proof artifact')
 const plain=new Map()
 const empty=sha('')
 for(const table of manifest.tables){
  if(table.rows===0&&table.file===null){if(table.lineSha256!==empty||table.recordSha256!==empty)throw refusal('portable_restore_archive_untrusted','empty table digest');continue}
  if(!Number.isSafeInteger(table.rows)||table.rows<1||!/^tables\/\d{4}\.rows\.enc$/.test(table.file??''))throw refusal('portable_restore_archive_untrusted','artifact path')
  const path=join(scratch,'table-'+plain.size)
  try{await unsealFile(join(archiveDirectory,table.file),path,key)}catch{throw refusal('portable_restore_archive_untrusted','table artifact authentication failed '+table.name)}
  const hash=createHash('sha256');let rows=0
  for await(const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})){hash.update(line+'\n');rows++}
  if(rows!==table.rows||hash.digest('hex')!==table.lineSha256)throw refusal('portable_restore_archive_untrusted','table content mismatch '+table.name)
  plain.set(table.name,path)
 }
 return plain
}
async function* archiveRows(path){
 for await(const line of createInterface({input:createReadStream(path),crlfDelay:Infinity}))yield JSON.parse(line)
}

async function importOrder(client,roster){
 const edges=(await client.query(`SELECT c.relname child,p.relname parent,k.conname FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class p ON p.oid=k.confrelid
  WHERE k.contype='f' AND NOT k.condeferrable AND c.relnamespace='public'::regnamespace AND k.conrelid<>k.confrelid`)).rows
 const deferred=new Set(roster.deferredReferences.map(item=>item.table+'.'+item.constraint))
 const names=Object.keys(roster.tables).filter(name=>['durable','rebound'].includes(roster.tables[name].class)).sort()
 const parents=new Map(names.map(name=>[name,new Set()]))
 for(const edge of edges)if(parents.has(edge.child)&&parents.has(edge.parent)&&!deferred.has(edge.child+'.'+edge.conname))parents.get(edge.child).add(edge.parent)
 // Reviewed validator reads: a structural validator that fires during import reads
 // these tables, so they are imported first (the builder proved the order acyclic).
 for(const {table,reads} of roster.validatorOrder??[])for(const read of reads)if(parents.has(table)&&parents.has(read))parents.get(table).add(read)
 const order=[],placed=new Set()
 while(order.length<names.length){
  const early=names.filter(name=>!roster.tables[name].importLate&&!placed.has(name))
  const ready=names.filter(name=>!placed.has(name)&&(!roster.tables[name].importLate||!early.length)&&[...parents.get(name)].every(parent=>placed.has(parent)))
  if(!ready.length)throw refusal('portable_restore_reference_cycle_unreviewed')
  for(const name of ready){order.push(name);placed.add(name)}
 }
 return order
}

async function tableShape(client,name){
 const columns=(await client.query(`SELECT a.attname::text name,a.attgenerated<>'' generated,a.attidentity identity FROM pg_attribute a
  WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,['public.'+name])).rows
 const primary=(await client.query(`SELECT array_agg(a.attname::text ORDER BY u.o) cols FROM pg_constraint k,unnest(k.conkey) WITH ORDINALITY u(n,o),pg_attribute a
  WHERE k.conrelid=$1::regclass AND k.contype='p' AND a.attrelid=k.conrelid AND a.attnum=u.n`,['public.'+name])).rows[0]?.cols??null
 const selfReferences=(await client.query(`SELECT ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n,o) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.n ORDER BY u.o) child,
   ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n,o) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.n ORDER BY u.o) parent
  FROM pg_constraint k WHERE k.conrelid=$1::regclass AND k.confrelid=k.conrelid AND k.contype='f' AND NOT k.condeferrable`,['public.'+name])).rows
 return{columns,primary,selfReferences}
}

async function stageRows(client,stage,name,rows){
 await client.query(`CREATE TEMP TABLE ${stage}(ord bigint PRIMARY KEY,actor text,x public.${ident(name)},done boolean NOT NULL DEFAULT false) ON COMMIT DROP`)
 let batch=[]
 const flush=async()=>{
  if(!batch.length)return
  await client.query(`INSERT INTO ${stage}(ord,actor,x) SELECT o,a,r::public.${ident(name)} FROM unnest($1::bigint[],$2::text[],$3::text[]) u(o,a,r)`,
   [batch.map(row=>row[0]),batch.map(row=>row[1]),batch.map(row=>row[2])]);batch=[]
 }
 let ord=0
 for await(const line of rows){batch.push(Array.isArray(line)?[ord++,line[0],line[1]]:[ord++,null,line]);if(batch.length>=500)await flush()}
 await flush()
 return ord
}

/**
 * Import an anchored archive into a fresh managed installation. On success the
 * target is committed but activation remains withheld.
 */
export async function importPortableBrain({ownerClient:client,archiveDirectory,key,expectedManifestSha256,erasureCheckpoint,
 sourceRoot=defaultSourceRoot,migrationDirs=[],roster:reviewedRoster,releaseThrough,authenticate,extensionTransitions}){
 if(!Buffer.isBuffer(key)||key.length!==32)throw refusal('portable_restore_key_required')
 if(!/^[a-f0-9]{64}$/.test(expectedManifestSha256??''))throw refusal('portable_restore_anchor_required')
 await requireOrdinaryOwner(client)
 const scratch=await mkdtemp(join(tmpdir(),'portable-import-'))
 try{
  // 1. Archive authenticity against the independent anchor; no archive DDL exists.
  const manifest=await readArchiveJson(join(archiveDirectory,'manifest.enc'),key,expectedManifestSha256,scratch,'portable_restore_archive_untrusted')
  if(manifest.format!==portableArchiveFormat)throw refusal('portable_restore_archive_untrusted','format')
  const roster=reviewedRoster??await loadPortableRoster()
  if(manifest.roster?.digest!==roster.digest)throw refusal('portable_restore_roster_mismatch')
  if(manifest.release?.through!==releaseThrough)throw refusal('portable_restore_source_release_mismatch','release cohort')
  if(extensionTransitions&&manifest.sourceProfile!=='embedded-superuser')throw refusal('portable_restore_schema_drift','engine transition requires an embedded source')
  const durable=Object.entries(roster.tables).filter(([,entry])=>entry.class!=='derived').map(([name])=>name).sort()
  for(const table of manifest.tables)if(!roster.tables[table.name]||roster.tables[table.name].class==='derived')throw refusal('portable_restore_unknown_table',table.name)
  if(JSON.stringify(manifest.tables.map(table=>table.name).sort())!==JSON.stringify(durable))throw refusal('portable_restore_roster_mismatch','archive table set')
  let checkpoint=null
  if(erasureCheckpoint){
   checkpoint=await readArchiveJson(erasureCheckpoint.path,key,erasureCheckpoint.expectedSha256,scratch,'portable_restore_checkpoint_untrusted')
   if(checkpoint.format!=='use-brian-portable-erasure-checkpoint-v1'||checkpoint.rosterDigest!==roster.digest)throw refusal('portable_restore_checkpoint_untrusted','format')
  }
  // 2. Trusted shipped schema before any data: target at the shipped head.
  const shipped=await releaseSet({sourceRoot,migrationDirs,releaseThrough})
  if(manifest.shipped.sha256!==sha(shipped.join('\n')))throw refusal('portable_restore_source_release_mismatch')
  const targetLedger=(await client.query('SELECT name FROM public._migrations ORDER BY name COLLATE "C"')).rows.map(row=>row.name)
  if(JSON.stringify(targetLedger)!==JSON.stringify(shipped))throw refusal('portable_restore_target_not_at_shipped_head')
  if(!compatibleLedger(manifest.ledger,shipped,await ledgerAliases(sourceRoot)))throw refusal('portable_restore_source_release_mismatch')
  // 3. Authenticate the installation against shipped source, not archive state.
  const verifyInstallation=authenticate??reviewedReleaseAuthentication(shipped.at(-1),sourceRoot)
  const firstAuthentication=await verifyInstallation(client)
  if(firstAuthentication.sourceDefinitionDigest!==manifest.installation.sourceDefinitionDigest||firstAuthentication.functions!==manifest.installation.functions)
   throw refusal('portable_restore_installation_identity_mismatch')
  const plaintext=await authenticateArchive(archiveDirectory,manifest,key,scratch)
  const derived=await readArchiveJson(join(archiveDirectory,manifest.derived.file),key,undefined,scratch,'portable_restore_archive_untrusted')
  for(const [name,entry] of Object.entries(roster.tables))if(entry.rule==='D8-transaction-scratch'&&derived[name]?.rows!==0)
   throw refusal('portable_restore_origin_scratch_not_empty',name)
  const crmSummary=crmSummaryPortable(roster)
  if(Boolean(manifest.credentials?.crmSummary)!==crmSummary||
   manifest.credentials&&Object.keys(manifest.credentials).some(name=>name!=='crmSummary'))
   throw refusal('portable_restore_archive_untrusted','CRM summary credential coverage')
  let crmCredentials=null
  if(crmSummary)try{crmCredentials=await readCrmSummaryCredentials(archiveDirectory,manifest.credentials.crmSummary,key)}
  catch{throw refusal('portable_restore_archive_untrusted','CRM summary credential authentication')}
  const receipt={schema:'portable-brain-import-receipt-v1',archiveId:manifest.archiveId,manifestSha256:expectedManifestSha256,rosterDigest:roster.digest,
   sourceProfile:manifest.sourceProfile??'ordinary-owner',...(releaseThrough?{release:{through:releaseThrough,migrations:shipped.length}}:{}),engineTransitions:[],
   targetAuthentication:[firstAuthentication],tables:{imported:0,rows:0,seedMatched:0,seedReplaced:0},rederived:{},suspendedTriggers:0,deferredFixups:0,reboundSlots:[],erasure:{replayed:0,alreadyPresent:0}}
  await client.query('BEGIN')
  try{
   await canonicalSession(client,{qualify:false})
   await verifyCatalogRoster(client,roster)
   receipt.engineTransitions=compareEngineFingerprints(manifest.fingerprint,await schemaFingerprint(client),extensionTransitions)
   // Installation-derived tables: compare logical identity with archived proofs.
   try{compareExecutableRegistryRosters(derived.native_turn_contract_helpers.records,(await client.query(executableRegistryProofSql)).rows)}
   catch{throw refusal('portable_restore_derived_roster_mismatch','native_turn_contract_helpers')}
   for(const name of ['native_retained_contract_helpers','private_session_display_contract']){
    const actual=(await client.query(`SELECT signature FROM public.${ident(name)} ORDER BY signature COLLATE "C"`)).rows.map(row=>row.signature)
    if(JSON.stringify(actual)!==JSON.stringify(derived[name].signatures))throw refusal('portable_restore_derived_roster_mismatch',name)
   }
   const targets=[];await readTable(client,'crm_erasure_journal_targets',roster.tables.crm_erasure_journal_targets,text=>{targets.push(text)})
   if(JSON.stringify(targets)!==JSON.stringify(derived.crm_erasure_journal_targets.rows_text))throw refusal('portable_restore_derived_roster_mismatch','crm_erasure_journal_targets')
   // Transaction-bound authority rows may never name a target future transaction.
   const current=BigInt((await client.query('SELECT pg_current_xact_id()::text v')).rows[0].v)
   if(BigInt(manifest.transactionHorizon)>=current)throw refusal('portable_restore_transaction_horizon_ahead',manifest.transactionHorizon+' >= '+current)
   // Canonical constraint boundary: deferrable checks run at COMMIT; named
   // derivation/admission/notification triggers are suspended inside this
   // transaction only. Validators, stamps and recovery capture keep firing.
   await client.query('SET CONSTRAINTS ALL DEFERRED')
   const toggle=async(keys,action)=>{for(const key of keys){const [table,trigger]=key.split('.');await client.query(`ALTER TABLE public.${ident(table)} ${action} TRIGGER ${ident(trigger)}`)}}
   const suspended=Object.entries(roster.triggers).filter(([,entry])=>entry.class.startsWith('suspended')&&entry.class!=='suspended:contract-window').map(([key])=>key)
   const windowed=Object.entries(roster.triggers).filter(([,entry])=>entry.class==='suspended:contract-window').map(([key])=>key)
   await toggle(suspended,'DISABLE')
   receipt.suspendedTriggers=suspended.length;receipt.windowedTriggers=windowed.length
   if(crmSummary){
    receipt.currentTable='crm-summary-credentials'
    const installed=await installCrmSummaryCredentials(client,crmCredentials)
    if(installed===null)throw refusal('portable_restore_target_not_fresh','crm_summary_receipt_keys')
    receipt.crmCredentialRecords=installed
   }
   const order=await importOrder(client,roster),byName=new Map(manifest.tables.map(table=>[table.name,table])),fixups=[]
   let stageIndex=0
   for(const name of order){
    receipt.currentTable=name
    const entry=roster.tables[name],table=byName.get(name),shape=await tableShape(client,name)
    let existing=0
    for(const actor of entry.forceRls?.access==='actor'?await actorIds(client):[null])
     existing+=(await withAccess(client,entry,actor,()=>client.query(`SELECT count(*)::int n FROM public.${ident(name)}`))).rows[0].n
    if(!table.rows&&!existing)continue
    const stage='portable_stage_'+(stageIndex++),window=windowed.filter(key=>key.startsWith(name+'.'))
    await toggle(window,'DISABLE')
    await stageRows(client,stage,name,archiveRows(plaintext.get(name))).catch(error=>{
     // A slot signature the authenticated target cannot resolve never binds.
     if(entry.slots&&['42883','42704','42601','22P02'].includes(error.code))throw refusal('portable_restore_unbound_regprocedure',name+': '+error.message)
     throw error
    })
    if(entry.excludeCompiledRecords){
     const legacy=portableLegacyConversionPredicate(name,column=>'(s.x).'+ident(column))
     if((await client.query(`SELECT EXISTS(SELECT 1 FROM ${stage} s WHERE (${legacy}) IS NOT TRUE) invalid`)).rows[0].invalid)
      throw refusal('portable_restore_archive_untrusted',name+' contains a compiled conversation projection')
    }
    if(name==='conversation_envelopes'&&entry.stripOnTransfer){
     const names=entry.stripOnTransfer.map(column=>'(x).'+ident(column)).join(',')
     if((await client.query(`SELECT EXISTS(SELECT 1 FROM ${stage} WHERE num_nonnulls(${names})<>0 OR (x).record_dirty_from IS DISTINCT FROM 0) invalid`)).rows[0].invalid)
      throw refusal('portable_restore_archive_untrusted',name+' contains a compiled conversation seal')
    }
    if(name==='episode_extraction_items'&&entry.stripOnTransfer){
     // Origin seal snapshots stay in the independently authenticated encrypted
     // artifact. They must be complete evidence of the corresponding historical
     // publication. The actual INSERT below never receives any seal field.
     const sealColumns=entry.stripOnTransfer.map(column=>'(x).'+ident(column)).join(',')
     const invalid=(await client.query(`SELECT EXISTS(SELECT 1 FROM ${stage} WHERE num_nonnulls(${sealColumns}) NOT IN (0,4)
      OR (x).configured_txid IS NOT NULL AND ((x).disposition IS DISTINCT FROM 'committed' OR (x).receipt_id IS NULL
       OR (x).configured_task->>'id' IS DISTINCT FROM (x).target_record_id
       OR (x).configured_source->>'runId' IS DISTINCT FROM (x).run_id::text
       OR (x).configured_source->>'candidateId' IS DISTINCT FROM (x).candidate_id
       OR (x).configured_source->>'payloadHash' IS DISTINCT FROM (x).payload_hash)) invalid`)).rows[0].invalid
     if(invalid)throw refusal('portable_restore_archive_untrusted',name+' has incomplete origin evidence')
    }
    if(entry.slots){
     // Rebind named slots only through the authenticated target catalog.
     await qualified(client)
     const bindings=(await client.query(`SELECT DISTINCT s.oid::regprocedure::text sig,n.nspname FROM ${stage} t,LATERAL unnest(ARRAY[${entry.slots.map(slot=>'(t.x).'+ident(slot)+'::oid').join(',')}]) s(oid)
       JOIN pg_proc p ON p.oid=s.oid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE s.oid IS NOT NULL ORDER BY 1`)).rows
     await unqualified(client)
     // Fingerprint equality already proved every public routine is shipped.
     for(const binding of bindings){if(binding.nspname!=='public')throw refusal('portable_restore_unbound_regprocedure',binding.sig);receipt.reboundSlots.push(binding.sig)}
    }
    if(existing&&!entry.seeded)throw refusal('portable_restore_target_not_fresh',name)
    if(existing){
     // Fresh installation: only rows the shipped installer seeds may pre-exist.
     await qualified(client)
     const matched=(await withAccess(client,entry,null,()=>client.query(`WITH m AS (UPDATE ${stage} s SET done=true FROM public.${ident(name)} t WHERE NOT s.done AND t::text=(s.x)::text RETURNING 1) SELECT count(*)::int n FROM m`))).rows[0].n
     await unqualified(client)
     receipt.tables.seedMatched+=matched
     let remaining=existing-matched
     if(remaining&&entry.seedReplaceKey){
      const keyMatch=entry.seedReplaceKey.map(column=>`t.${ident(column)}=(s.x).${ident(column)}`).join(' AND ')
      const assignable=shape.columns.filter(column=>!column.generated&&!entry.seedReplaceKey.includes(column.name)).map(column=>column.name)
      const replaced=(await client.query(`WITH m AS (UPDATE public.${ident(name)} t SET (${assignable.map(ident).join(',')})=ROW(${assignable.map(column=>'(s.x).'+ident(column)).join(',')})
        FROM ${stage} s WHERE NOT s.done AND ${keyMatch} RETURNING s.ord) UPDATE ${stage} s SET done=true FROM m WHERE s.ord=m.ord RETURNING 1`)).rowCount
      receipt.tables.seedReplaced+=replaced;remaining-=replaced
     }
     if(remaining)throw refusal('portable_restore_target_not_fresh',name)
    }
    const deferredColumns=new Set(roster.deferredReferences.filter(item=>item.table===name).flatMap(item=>item.columns))
    if(deferredColumns.size){if(!shape.primary)throw refusal('portable_restore_reference_cycle_unreviewed',name);fixups.push({name,stage,shape,columns:[...deferredColumns]})}
    const insertable=shape.columns.filter(column=>!column.generated&&!entry.stripOnTransfer?.includes(column.name))
    const overriding=shape.columns.some(column=>column.identity==='a')?' OVERRIDING SYSTEM VALUE':''
    const values=insertable.map(column=>deferredColumns.has(column.name)?'NULL':'(s.x).'+ident(column.name)).join(',')
    const parentPending=shape.selfReferences.length?' AND NOT EXISTS(SELECT 1 FROM '+stage+' p WHERE NOT p.done AND p.ord<>s.ord AND ('+shape.selfReferences.map(reference=>
      reference.child.map((column,index)=>`(p.x).${ident(reference.parent[index])}=(s.x).${ident(column)}`).join(' AND ')).join(') OR (')+'))':''
    const actors=entry.forceRls?.access==='actor'?(await client.query(`SELECT DISTINCT actor FROM ${stage} WHERE NOT done ORDER BY 1`)).rows.map(row=>row.actor):[null]
    for(const actor of actors){
     const actorFilter=actor===null?'':' AND s.actor='+lit(actor)
     for(;;){
      const inserted=await withAccess(client,entry,actor,()=>client.query(`WITH batch AS (SELECT s.ord FROM ${stage} s WHERE NOT s.done${actorFilter}${parentPending}),
        ins AS (INSERT INTO public.${ident(name)}(${insertable.map(column=>ident(column.name)).join(',')})${overriding}
         SELECT ${values} FROM ${stage} s JOIN batch b ON b.ord=s.ord ORDER BY s.ord RETURNING 1)
        UPDATE ${stage} s SET done=true FROM batch b WHERE s.ord=b.ord`))
      receipt.tables.rows+=inserted.rowCount
      const pending=(await client.query(`SELECT count(*)::int n FROM ${stage} s WHERE NOT s.done${actorFilter}`)).rows[0].n
      if(!pending)break
      if(!inserted.rowCount)throw refusal('portable_restore_reference_cycle_unreviewed',name)
     }
    }
    receipt.tables.imported++
    if(window.length){
     // Close the window before any other table: run this table's own deferred
     // validators now (ALTER refuses pending events), then roots must be current.
     const deferredOwn=(await client.query(`SELECT DISTINCT k.conname FROM pg_constraint k WHERE k.conrelid=$1::regclass AND k.contype='t' AND k.condeferrable ORDER BY 1`,['public.'+name])).rows.map(row=>row.conname)
     if(deferredOwn.length)await client.query(`SET CONSTRAINTS ${deferredOwn.map(constraint=>'public.'+ident(constraint)).join(',')} IMMEDIATE`)
     await toggle(window,'ENABLE')
     if(deferredOwn.length)await client.query(`SET CONSTRAINTS ${deferredOwn.map(constraint=>'public.'+ident(constraint)).join(',')} DEFERRED`)
     if((await client.query('SELECT native_turn_helpers_current() IS TRUE ok')).rows[0].ok!==true)throw refusal('portable_restore_contract_window_unclosed',name)
    }
    if(!deferredColumns.size)await client.query(`DROP TABLE ${stage}`)
   }
   // Deferred cycle references restored by primary key after every parent exists.
   for(const fixup of fixups){
    const keyMatch=fixup.shape.primary.map(column=>`t.${ident(column)}=(s.x).${ident(column)}`).join(' AND ')
    const changed=fixup.columns.map(column=>`(s.x).${ident(column)} IS NOT NULL`).join(' OR ')
    const result=await withAccess(client,roster.tables[fixup.name],null,()=>client.query(`UPDATE public.${ident(fixup.name)} t SET (${fixup.columns.map(ident).join(',')})=ROW(${fixup.columns.map(column=>'(s.x).'+ident(column)).join(',')})
      FROM ${fixup.stage} s WHERE ${keyMatch} AND (${changed})`))
    receipt.deferredFixups+=result.rowCount
    await client.query(`DROP TABLE ${fixup.stage}`)
   }
   for(const [name,value] of Object.entries(manifest.sequences)){
    if(!roster.sequences[name])throw refusal('portable_restore_unknown_sequence',name)
    await client.query('SELECT setval($1::regclass,$2::bigint,$3)',['public.'+name,value.lastValue,value.isCalled])
   }
   if(crmSummary){
    receipt.currentTable='crm-summary-projections'
    receipt.crmProjections=await rebuildCrmSummaryProjections(client)
    for(const [name,entry] of Object.entries(roster.tables))if(entry.rule===crmSummaryProjectionRule
     &&name!=='crm_summary_principal_revisions'&&name!=='crm_summary_release_revisions'){
     const actual=await tableDigest(client,name,entry),original=derived[name]
     if(!original||actual.rows!==original.rows||actual.sha256!==original.sha256)
      throw refusal('portable_restore_crm_projection_digest_mismatch',name)
    }
   }
   // Run every deferred check against the complete restored set before the
   // suspended triggers are re-enabled (ALTER refuses pending trigger events).
   receipt.currentTable='deferred-constraints'
   await client.query('SET CONSTRAINTS ALL IMMEDIATE')
   receipt.currentTable='trigger-restoration'
   await toggle(suspended,'ENABLE')
   await verifyCatalogRoster(client,roster)
   compareEngineFingerprints(manifest.fingerprint,await schemaFingerprint(client),extensionTransitions)
   // Exact durable proof: every imported table equals its archived record digest.
   for(const table of manifest.tables){
    if(roster.tables[table.name].class==='rederived'){
     // Re-derived maintenance state: every archived key was re-derived by the shipped trigger.
     if(!table.rows)continue
     const stage='portable_rederived_'+(stageIndex++),shape=await tableShape(client,table.name)
     const keyColumns=table.name==='native_conversation_conversion_pending'&&roster.tables[table.name].excludeCompiledRecords
      ?['workspace_id','kind','id','version']:shape.primary
     if(!keyColumns)throw refusal('portable_restore_rederived_mismatch',table.name+' key')
     await stageRows(client,stage,table.name,archiveRows(plaintext.get(table.name)))
     const missing=(await client.query(`SELECT count(*)::int n FROM ${stage} s WHERE NOT EXISTS(SELECT 1 FROM public.${ident(table.name)} t WHERE ${keyColumns.map(column=>`t.${ident(column)} IS NOT DISTINCT FROM (s.x).${ident(column)}`).join(' AND ')})`)).rows[0].n
     if(missing)throw refusal('portable_restore_rederived_mismatch',table.name)
     receipt.rederived[table.name]={archived:table.rows,present:(await client.query(`SELECT count(*)::int n FROM public.${ident(table.name)}`)).rows[0].n}
     await client.query(`DROP TABLE ${stage}`);continue
    }
    const proof=await tableDigest(client,table.name,roster.tables[table.name])
    if(proof.rows!==table.rows||proof.sha256!==table.recordSha256)throw refusal('portable_restore_digest_mismatch',table.name)
   }
   for(const [name,value] of Object.entries(manifest.sequences)){
    const owner=roster.sequences[name].owner
    if(owner){const [table,column]=owner.split('.');const behind=(await withAccess(client,roster.tables[table],null,()=>client.query(`SELECT coalesce(max(${ident(column)}),0)>$1::bigint behind FROM public.${ident(table)}`,[value.lastValue]))).rows[0].behind;if(behind)throw refusal('portable_restore_sequence_behind',name)}
   }
   receipt.currentTable='erasure-replay'
   if(checkpoint)receipt.erasure=await replayErasureOriginMode(client,checkpoint,roster)
   // The registry-guard witness (D7) is installation-derived: re-record it from
   // the restored target catalog as the last step, never from the archive.
   if(Object.values(roster.tables).some(entry=>entry.rule==='D7-contract-witness')){
    receipt.currentTable='witness-refresh'
    if((await client.query('SELECT public.native_turn_contract_witness_refresh() IS TRUE ok')).rows[0].ok!==true)throw refusal('portable_restore_witness_refresh_failed')
    receipt.witnessRefreshed=true
   }
   delete receipt.currentTable
   await client.query('COMMIT')
  }catch(error){
   await client.query('ROLLBACK').catch(()=>{})
   if(error instanceof PortableRestoreRefusal)throw error
   throw refusal('portable_restore_import_refused',[receipt.currentTable,error.code,error.message,error.detail,error.where?.split('\n')[0]].filter(Boolean).join(' | '))
  }
  // 4. Authenticate again after data; activation stays withheld.
  const secondAuthentication=await verifyInstallation(client)
  if(secondAuthentication.sourceDefinitionDigest!==firstAuthentication.sourceDefinitionDigest||secondAuthentication.localContractDigest!==firstAuthentication.localContractDigest)
   throw refusal('portable_restore_installation_identity_mismatch','after import')
  receipt.targetAuthentication.push(secondAuthentication)
  receipt.status='imported';receipt.activation='withheld';receipt.completedAt=new Date().toISOString()
  receipt.receiptSha256=sha(JSON.stringify(receipt))
  return Object.freeze(receipt)
 }finally{await rm(scratch,{recursive:true,force:true})}
}

// Origin-mode replay: the session replication role stays 'origin' and every
// trigger is enabled. Capture is off; the original journal record is appended.
async function replayErasureOriginMode(client,checkpoint,roster){
 const role=(await client.query("SELECT current_setting('session_replication_role') r")).rows[0].r
 if(role!=='origin')throw refusal('portable_restore_erasure_replay_mode',role)
 await qualified(client)
 const restored=(await client.query('SELECT t::text r FROM public.crm_erasure_journal t ORDER BY sequence')).rows.map(row=>row.r)
 await unqualified(client)
 if(checkpoint.records.length<restored.length||restored.some((record,index)=>checkpoint.records[index]!==record))throw refusal('portable_restore_checkpoint_lineage_mismatch')
 let replayed=0
 for(const payload of checkpoint.records.slice(restored.length)){
  const row=(await client.query(`SELECT (j).table_name,(j).operation,(j).row_key::text row_key,(j).effect::text effect,ARRAY(SELECT jsonb_object_keys((j).row_key)) key_names,
    ARRAY(SELECT jsonb_object_keys(coalesce((j).effect,'{}'))) effect_names FROM (SELECT $1::public.crm_erasure_journal j) x`,[payload])).rows[0]
  const registry=(await client.query('SELECT key_columns FROM public.crm_erasure_journal_targets WHERE table_name=$1',[row.table_name])).rows[0]
  if(!registry||JSON.stringify([...registry.key_columns].sort())!==JSON.stringify([...row.key_names].sort()))throw refusal('portable_restore_erasure_target_unknown',row.table_name)
  const table='public.'+ident(row.table_name),match=registry.key_columns.map(column=>`t.${ident(column)} IS NOT DISTINCT FROM k.${ident(column)}`).join(' AND ')
  const entry=roster.tables[row.table_name]
  if(!entry||entry.class==='derived')throw refusal('portable_restore_erasure_target_unknown',row.table_name)
  // FORCE-RLS targets use their reviewed access path; actor partitions are tried per actor.
  const effect=async sql=>{
   for(const actor of entry.forceRls?.access==='actor'?await actorIds(client):[null])
    if((await withAccess(client,entry,actor,()=>client.query(sql,[row.row_key,row.effect]))).rowCount)return
  }
  if(row.operation==='delete'){
   if(row.effect!==null)throw refusal('portable_restore_erasure_effect_invalid')
   await effect(`DELETE FROM ${table} t USING jsonb_populate_record(NULL::${table},$1::jsonb) k WHERE ${match} AND $2::jsonb IS NULL`)
  }else if(row.operation==='update'){
   if(!row.effect_names.length||row.effect_names.some(column=>registry.key_columns.includes(column)))throw refusal('portable_restore_erasure_effect_invalid')
   const names=row.effect_names.map(ident)
   await effect(`UPDATE ${table} t SET (${names.join(',')})=(SELECT ${names.join(',')} FROM jsonb_populate_record(NULL::${table},$2::jsonb))
    FROM jsonb_populate_record(NULL::${table},$1::jsonb) k WHERE ${match}`)
  }else if(row.operation==='insert'){
   const capture=(await client.query('SELECT capture_inserts FROM public.crm_erasure_journal_targets WHERE table_name=$1',[row.table_name])).rows[0]
   if(!capture?.capture_inserts)throw refusal('portable_restore_erasure_effect_invalid','insert')
   await client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,[row.effect])
  }else throw refusal('portable_restore_erasure_effect_invalid',row.operation)
  await client.query('INSERT INTO public.crm_erasure_journal OVERRIDING SYSTEM VALUE SELECT ($1::public.crm_erasure_journal).*',[payload])
  replayed++
 }
 await client.query("SELECT setval(pg_get_serial_sequence('public.crm_erasure_journal','sequence'),GREATEST(coalesce((SELECT max(sequence) FROM public.crm_erasure_journal),0),1),EXISTS(SELECT 1 FROM public.crm_erasure_journal))")
 return{replayed,alreadyPresent:restored.length}
}

/**
 * Activation gate. A restored installation is admitted only with a passing
 * receiving proof bound to the exact import receipt and a fresh authentication.
 */
export async function admitRestoredInstallation({ownerClient:client,importReceipt,receivingProof,forwardMigration,authenticate=authenticateRestoredHead}){
 if(importReceipt?.status!=='imported'||importReceipt.activation!=='withheld')throw refusal('portable_restore_activation_withheld','import receipt')
 const {receiptSha256,...unsigned}=importReceipt
 if(sha(JSON.stringify(unsigned))!==receiptSha256)throw refusal('portable_restore_activation_withheld','import receipt digest')
 if(receivingProof?.importReceiptSha256!==receiptSha256||receivingProof.status!=='passed'||!Array.isArray(receivingProof.checks)
  ||!receivingProof.checks.length||receivingProof.checks.some(check=>check.passed!==true))throw refusal('portable_restore_activation_withheld','receiving proof')
 if(forwardMigration!==undefined){
  // A release-cohort import admitted after the shipped forward migrations: the
  // proof, the forward receipt and the current head authentication must agree.
  const {receiptSha256:forwardSha256,...forwardUnsigned}=forwardMigration??{}
  if(sha(JSON.stringify(forwardUnsigned))!==forwardSha256||forwardMigration.importReceiptSha256!==receiptSha256||receivingProof.forwardMigrationSha256!==forwardSha256
   ||forwardMigration.from?.localContractDigest!==importReceipt.targetAuthentication.at(-1).localContractDigest||forwardMigration.from?.through!==importReceipt.release?.through)
   throw refusal('portable_restore_activation_withheld','forward migration receipt')
  const ledger=(await client.query('SELECT name FROM public._migrations ORDER BY name COLLATE "C"')).rows.map(row=>row.name)
  if(sha(ledger.join('\n'))!==forwardMigration.ledgerSha256)throw refusal('portable_restore_activation_withheld','ledger changed')
  const authentication=await authenticate(client)
  if(authentication.localContractDigest!==forwardMigration.authentication?.localContractDigest)throw refusal('portable_restore_activation_withheld','installation changed')
  return Object.freeze({activation:'admitted',importReceiptSha256:receiptSha256,forwardMigrationSha256:forwardSha256,receivingProofSha256:sha(JSON.stringify(receivingProof)),authentication})
 }
 const authentication=await authenticate(client)
 if(authentication.localContractDigest!==importReceipt.targetAuthentication.at(-1).localContractDigest)throw refusal('portable_restore_activation_withheld','installation changed')
 return Object.freeze({activation:'admitted',importReceiptSha256:receiptSha256,receivingProofSha256:sha(JSON.stringify(receivingProof)),authentication})
}

/**
 * Bind a release-cohort import to the shipped migrations applied after it. The
 * target must now be at the full shipped head; the applied names are exactly the
 * shipped files after the cohort (the import already proved the ledger was the cohort).
 */
export async function recordForwardMigration({ownerClient:client,importReceipt,authentication,sourceRoot=defaultSourceRoot,migrationDirs=[]}){
 await requireOrdinaryOwner(client)
 const through=importReceipt?.release?.through
 if(importReceipt?.status!=='imported'||typeof through!=='string')throw refusal('portable_restore_activation_withheld','forward migration requires a release-cohort import')
 if(!/^[a-f0-9]{64}$/.test(authentication?.localContractDigest??''))throw refusal('portable_restore_activation_withheld','head authentication')
 const shipped=await shippedMigrationSet({sourceRoot,migrationDirs})
 const ledger=(await client.query('SELECT name FROM public._migrations ORDER BY name COLLATE "C"')).rows.map(row=>row.name)
 if(JSON.stringify(ledger)!==JSON.stringify(shipped))throw refusal('portable_restore_target_not_at_shipped_head','after forward migration')
 const receipt={schema:'portable-brain-forward-migration-receipt-v1',importReceiptSha256:importReceipt.receiptSha256,
  from:{through,localContractDigest:importReceipt.targetAuthentication.at(-1).localContractDigest},
  applied:shipped.filter(name=>name>through),ledgerSha256:sha(ledger.join('\n')),authentication:{...authentication}}
 receipt.receiptSha256=sha(JSON.stringify(receipt))
 return Object.freeze(receipt)
}

export async function writeImportReceipt(path,receipt){await writeFile(path,JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'})}
