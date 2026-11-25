/** Reviewed portable-restore roster and pre-database archive refusals. [COMP:api/portable-restore] */
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises'
import {randomBytes,createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll,describe,expect,it} from 'vitest'

const directory=new URL('../../../scripts/conversation-store/',import.meta.url)
const restore=await import(new URL('portable-restore.mjs',directory).href)
const builder=await import(new URL('build-portable-restore-roster.mjs',directory).href)
const {portableOwnerPolicies,portableLegacyConversionTables,restoreStrippedFields}=await import(new URL('portable-restore-seals.mjs',directory).href)
const {crmSummaryOriginStamps,crmSummaryStructuralValidators}=await import(new URL('crm-summary-portable.mjs',directory).href)
const record=await import(new URL('executable-record.mjs',directory).href)
const {sealJson}=await import(new URL('../../../../../scripts/operations/recovery-common.mjs',import.meta.url).href)
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const scratch:string[]=[]
afterAll(async()=>{for(const path of scratch)await rm(path,{recursive:true,force:true})})

const crmSummaryProjections=[
 'crm_summary_attention_rollups','crm_summary_company_references','crm_summary_configuration_publications',
 'crm_summary_entity_publications','crm_summary_principal_revisions','crm_summary_release_revisions',
 'crm_summary_rollup_leaves','crm_summary_rollups','crm_summary_scope_policy_usage','crm_summary_selected_cells',
]
const crmSummaryDurableFacts=[
 'crm_summary_partition_leaves','crm_summary_policy_adapters','crm_summary_policy_inputs','crm_summary_policy_requirements',
 'crm_summary_record_policies','crm_summary_scope_classes','crm_summary_source_descriptors','crm_summary_source_groups',
]
const crmSummaryEpochs=['crm_summary_entity_domain_versions','crm_summary_scope_partition_versions']
const crmSummaryCredentials='crm_summary_receipt_keys'

/** An idle ordinary owner that refuses any query beyond the owner check. */
function ownerOnly(){
 const queries:string[]=[]
 return{queries,getTransactionStatus:()=>'I',async query(sql:string){
  queries.push(sql)
  if(queries.length===1&&sql.includes('FROM pg_roles r,pg_class c'))return{rows:[{rolsuper:false,rolbypassrls:false,owns:true}]}
  throw new Error('unexpected target query before archive authentication')
 }}
}

describe('[COMP:api/portable-restore] reviewed harness extension',()=>{
 it('extends only the pinned reviewed baseline with seven durable facts',async()=>{
  const review=await import(new URL('portable-harness-review.mjs',directory).href)
  const text=await readFile(new URL('portable-restore-roster-8334.json',directory),'utf8')
  const input=review.harnessClassificationFrom8334(text)
  expect(input.ledgerCount).toBe(813)
  expect(input.tables).toHaveLength(604)
  expect(input.tables.filter((entry:{table:string})=>review.harnessTables.includes(entry.table))).toEqual(
   [...review.harnessTables].sort().map(table=>({schema:'public',table,ownership:'durable',
    generatedColumns:table==='project_harness_revisions'?['scope_id']:[],identityColumns:[],forceRls:false,namedSlots:[]})))
  expect(()=>review.harnessClassificationFrom8334(text+' ')).toThrow('portable_harness_reviewed_baseline_changed')
  expect(review.harnessTriggerReview['project_harness_runs.harness_run_audit']).toBe('suspended:derived-effect')
 })
 it('refuses unknown harness catalog names before reading the expected digest',async()=>{
  const {readReviewedCrmCatalog}=await import(new URL('crm-release-catalog.mjs',directory).href)
  const owner={query:async()=>({rows:[{name:'project_harness_unreviewed'}]})}
  await expect(readReviewedCrmCatalog(owner,{closedPrefixes:{functions:['project_harness_'],tables:['project_harness_']},functions:[],tables:[]}))
   .rejects.toThrow('portable_successor_unknown_catalog_object')
 })
 it('checks every extension receipt inside the authentication snapshot and rolls back refusal',async()=>{
  const {authenticateCrmSuccessor}=await import(new URL('crm-release-catalog.mjs',directory).href)
  const catalog=JSON.stringify({routines:null,relations:null,types:null,triggers:null})
  const inventory={sha256:sha(catalog),routines:0,relations:0,types:0,triggers:0}
  const scope={functions:[],tables:[],types:[],triggers:[]}
  const migrations=['8335_project_harnesses.sql','8336_project_harness_verification.sql','8337_project_chat_creation_admission.sql']
  for(const missing of [undefined,...migrations]){
   const queries:string[]=[]
   const owner={getTransactionStatus:()=>'I',async query(sql:string,args?:string[][]){
    queries.push(sql)
    if(sql.includes('SELECT name FROM public._migrations'))return{rows:args![0].filter(name=>name!==missing).map(name=>({name}))}
    if(sql==='reviewed proof')return{rows:[{witness_current:true,functions:1,local_digest:'a'.repeat(64)}]}
    if(sql.includes('WITH runtime AS'))return{rows:[{catalog}]}
    return{rows:[]}
   }}
   const attempt=authenticateCrmSuccessor(owner,{sql:'reviewed proof',cleanup:'reviewed cleanup',functions:1,sourceDigest:'proof',
    crmScope:scope,crmInventory:inventory,portableSuccessor:{scope,inventory,migrations}})
   if(missing){await expect(attempt).rejects.toThrow('portable_successor_migration_tail_missing');expect(queries.at(-1)).toBe('ROLLBACK')}
   else{await expect(attempt).resolves.toMatchObject({witnessCurrent:true});expect(queries.at(-1)).toBe('COMMIT')}
   expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ')
  }
 })
 it('binds the 8337 source profile rather than aliasing 8334', { timeout: 15_000 }, async()=>{
  const profile=await import(new URL('installation-authentication-8337.mjs',directory).href)
  const source=await profile.currentInstallationAuthenticationSource()
  expect(source.portableSuccessor.inventory).toMatchObject({routines:23,relations:8,types:0,triggers:11})
  expect(source.portableSuccessor.migrations).toEqual(Object.keys(profile.harnessMigrationPins))
  const releases=await import(new URL('installation-release.mjs',directory).href)
  expect(releases.hasInstallationRelease('8337_project_chat_creation_admission.sql')).toBe(true)
 })
 it('binds the packed Memory release without replacing the preceding release profile', { timeout: 15_000 }, async()=>{
  const {currentReleaseSource}=await import(new URL('installation-release.mjs',directory).href)
  const previous='8351_scope_derivation_parent_lookup.sql',head='8352_packed_memory_observation.sql'
  const [oldSource,newSource]=await Promise.all([currentReleaseSource(previous),currentReleaseSource(head)])
  expect(oldSource.portableSuccessor.migrations.at(-1)).toBe(previous)
  expect(newSource.portableSuccessor.migrations).toEqual([...oldSource.portableSuccessor.migrations,head])
  expect(newSource.sourceDigest).not.toBe(oldSource.sourceDigest)
  expect(newSource.additionalCatalogs.slice(0,-1)).toEqual(oldSource.additionalCatalogs)
  expect(newSource.additionalCatalogs.at(-1).scope.functions).toEqual([
   'capture_native_prompt_memory_sections_once','capture_native_prompt_memory_sections_v2',
   'observe_native_prompt_memory_field_once','read_native_memory_query_projection_once',
  ])
 })
})

describe('[COMP:api/portable-restore] finite portable restore roster',()=>{
 it('classifies every inventoried table exactly once with a reviewed rule',async()=>{
  const roster=await restore.loadPortableRoster()
  const entries=Object.entries(roster.tables) as [string,{class:string;rule:string;slots?:string[];forceRls?:unknown;generated?:string[];identity?:string[]}][]
  expect(entries).toHaveLength(606)
  expect(roster.counts).toMatchObject({tables:606,derived:22,rederived:1,rebound:2,durable:581,regprocedureSlots:4,forceRls:11,generatedTables:5,identityTables:4,sequences:6})
  expect(roster.tables.workspace_mcp_dispatch).toEqual({class:'durable',rule:'F1-durable-fact'})
  expect(roster.triggers['workspace_mcp_runs.workspace_mcp_dispatch_sync']).toMatchObject({class:'suspended:derived-effect'})
  for(const [,entry] of entries)expect(Object.keys(roster.rules)).toContain(entry.rule)
  expect(entries.filter(([,entry])=>entry.class==='derived').map(([name])=>name).sort()).toEqual(
   ['_migrations','conversation_envelope_backfill_checkpoint','conversation_settings_transitions','crm_erasure_journal_targets',
    'crm_import_csv_index_chunks','crm_import_csv_indexes','native_memory_query_write_intents','native_retained_contract_helpers','native_turn_contract_helpers','native_turn_contract_witness','private_session_display_contract',
    ...crmSummaryProjections,crmSummaryCredentials].sort())
  for(const name of crmSummaryProjections)expect(roster.tables[name]).toEqual({class:'derived',rule:'D10-crm-summary-projection'})
  for(const name of crmSummaryDurableFacts)expect(roster.tables[name]).toEqual({class:'durable',rule:'F1-durable-fact'})
  expect(roster.tables[crmSummaryCredentials]).toEqual({class:'derived',rule:'D11-crm-summary-credential'})
  expect(roster.tables.native_memory_query_write_intents).toEqual({class:'derived',rule:'D8-transaction-scratch',transactionBound:['transaction_id']})
  // 8276 registry-guard witness: installation-derived, re-recorded after import.
  expect(roster.tables.native_turn_contract_witness).toEqual({class:'derived',rule:'D7-contract-witness'})
  expect(Object.fromEntries(entries.filter(([,entry])=>entry.slots).map(([name,entry])=>[name,entry.slots]))).toEqual({
   application_native_configuration_operations:['apply_handler'],
   application_native_field_contracts:['metadata_reader','catalog_reader','configuration_reader']})
  expect(entries.filter(([,entry])=>entry.rule==='F2-authority-epoch').map(([name])=>name).sort()).toEqual(
   ['application_native_crm_configuration_epochs','application_policy_contract_epoch','application_policy_workspace_epochs','ledger_epoch',...crmSummaryEpochs].sort())
  expect(roster.inventoryOverrides).toEqual({native_conversation_conversion_pending:'D6-enrollment-maintenance'})
 })
 it('pins the 8273 release-cohort roster used by the existing-brain transfer',async()=>{
  const embedded=await import(new URL('../../../scripts/conversation-store/pglite-portable-source.mjs',import.meta.url).href)
  const cohort=await embedded.loadCohortRoster(),head=await restore.loadPortableRoster()
  expect(cohort.digest).toBe(embedded.embeddedTransferCohort.rosterSha256)
  expect(cohort.counts).toMatchObject({tables:564,derived:5,rederived:1,rebound:2,durable:556})
  expect(Object.keys(head.tables).filter(name=>!cohort.tables[name]).sort()).toEqual([
   'conversation_envelope_backfill_checkpoint','conversation_envelopes','conversation_legacy_history_enrollments',
   'conversation_message_quarantine','conversation_participants','conversation_settings_transitions',
   'conversation_visibility_audit','conversation_visibility_notices','native_memory_query_write_intents','native_turn_completions','native_turn_contract_witness','workspace_mcp_dispatch',
   'crm_import_csv_index_chunks','crm_import_csv_indexes',...crmSummaryProjections,...crmSummaryDurableFacts,...crmSummaryEpochs,crmSummaryCredentials,
   'project_harness_products','project_harness_components','project_harness_revisions','project_harness_approvals',
   'project_harness_runs','project_harness_evidence','project_harness_execution_audit'].sort())
  const forcedAtCohortOnly=['page_link_aliases','realtime_thread_targets','task_candidates','task_rules','task_tombstones','workspace_brand_versions','workspace_brands','workspace_link_aliases']
  const changed=[...forcedAtCohortOnly,...Object.keys(portableOwnerPolicies),'episode_extraction_items',...portableLegacyConversionTables].sort()
  expect(Object.keys(cohort.tables).filter(name=>JSON.stringify(cohort.tables[name])!==JSON.stringify(head.tables[name])).sort()).toEqual(changed)
  for(const name of forcedAtCohortOnly){
   expect(cohort.tables[name].forceRls).toMatchObject({access:'system'});expect(head.tables[name].forceRls).toBeUndefined()
   const {forceRls:_retired,...rest}=cohort.tables[name];expect(head.tables[name]).toEqual(rest)
  }
  for(const [table,policy] of Object.entries(portableOwnerPolicies)){
   expect(cohort.tables[table].forceRls).toMatchObject({access:'system'})
   expect(head.tables[table].forceRls).toMatchObject({access:'owner',policy})
  }
  for(const [table,fields] of Object.entries(restoreStrippedFields as Record<string,Record<string,string>>))expect(head.tables[table].stripOnTransfer).toEqual(Object.keys(fields))
  for(const table of portableLegacyConversionTables)expect(head.tables[table].excludeCompiledRecords).toBe(true)
  for(const [name,trigger] of Object.entries(cohort.triggers))expect(head.triggers[name]).toEqual(trigger)
  expect(head.triggers['sessions.zzzz_conversation_envelope']).toMatchObject({class:'suspended:derived-effect'})
 })
 it('binds the roster to the current shipped chain and still refuses unknown or missing tables',async()=>{
  const roster=await restore.loadPortableRoster()
  // The committed roster is bound to the current shipped chain: a new migration must regenerate it.
  const shipped=await restore.shippedMigrationSet()
  expect(roster.inventory).toMatchObject({ledgerCount:shipped.length,ledgerHead:shipped.at(-1)})
  const names=Object.keys(roster.tables)
  const catalog=(tables:string[])=>({getTransactionStatus:()=>'I',async query(){return{rows:tables.map(relname=>({relname,force_rls:Boolean(roster.tables[relname]?.forceRls)}))}}})
  await expect(restore.verifyCatalogRoster(catalog([...names,'unreviewed_fact']),roster)).rejects.toMatchObject({code:'portable_restore_unknown_table'})
  // A head roster never accepts a catalog without the 8276 witness (or any other reviewed table).
  await expect(restore.verifyCatalogRoster(catalog(names.filter(name=>name!=='native_turn_contract_witness')),roster)).rejects.toMatchObject({code:'portable_restore_roster_table_missing'})
  // The builder refuses an inventory reviewed against a different ledger length.
  const chain=(entries:number)=>({async query(sql:string){return{rows:sql.includes('_migrations')?Array.from({length:entries},(_,index)=>({name:String(index).padStart(4,'0')+'.sql'})):[]}}})
  await expect(builder.buildRoster(chain(758),{format:1,tables:[],ledgerCount:759})).rejects.toThrow('portable_roster_ledger_drift')
 })
 it('names every trigger class, keeps validators firing and leaves the reference graph acyclic',async()=>{
  const roster=await restore.loadPortableRoster()
  const classes=new Set(Object.values(roster.triggers as Record<string,{class:string}>).map(trigger=>trigger.class))
  for(const value of classes)expect(Object.keys(roster.triggerRules)).toContain(value)
  // Recovery capture always fires; it is inert because import never enables capture.
  for(const [key,trigger] of Object.entries(roster.triggers as Record<string,{class:string}>))if(key.endsWith('.crm_recovery_capture'))expect(trigger.class).toBe('fires:recovery-capture')
  expect(Object.values(roster.triggers as Record<string,{class:string}>).filter(trigger=>trigger.class==='fires').length).toBeGreaterThan(roster.counts.suspendedTriggers)
  for(const reference of roster.deferredReferences)expect(roster.tables[reference.table].class).not.toBe('derived')
 })
 it('suspends every reviewed origin stamp, including the 8063 lease stamp, in the head and the 8273 cohort roster',async()=>{
  const embedded=await import(new URL('../../../scripts/conversation-store/pglite-portable-source.mjs',import.meta.url).href)
  const head=await restore.loadPortableRoster(),cohort=await embedded.loadCohortRoster()
  for(const roster of [head,cohort]){
   const triggers=roster.triggers as Record<string,{class:string;events:string[]}>
   const expectedStamps=roster===head?[...builder.originStamps,...crmSummaryOriginStamps]:[...builder.originStamps]
   // A released lease leaves last_turn_lease_token behind; firing the INSERT branch would overwrite it with NULL.
   expect(triggers['sessions.remember_native_session_turn_lease']).toMatchObject({class:'suspended:origin-stamp',function:'remember_native_session_turn_lease()'})
   expect(roster.originStamps).toEqual(expectedStamps);expect(roster.fixpointStamps).toEqual([...builder.fixpointStamps])
   expect(Object.entries(triggers).filter(([,trigger])=>trigger.class==='suspended:origin-stamp').map(([key])=>key).sort()).toEqual(expectedStamps.sort())
   // A fixpoint stamp is not an origin stamp; its validation may still be origin-bound or read a placeholder.
   for(const key of builder.fixpointStamps)expect(triggers[key].class).not.toBe('suspended:origin-stamp')
   for(const key of expectedStamps)expect(triggers[key].events).toContain('insert')
  }
  expect(head.counts.suspendedTriggers).toBe(398);expect(cohort.counts.suspendedTriggers).toBe(344)
  expect(head.originStamps).toHaveLength(65);expect(builder.originStamps).toHaveLength(62);expect(builder.fixpointStamps).toHaveLength(17)
  expect(new Set([...builder.originStamps,...builder.fixpointStamps]).size).toBe(79)
  expect(cohort.inventory).toMatchObject({ledgerCount:756,ledgerHead:embedded.embeddedTransferCohort.through})
  expect(builder.cohortRosters[embedded.embeddedTransferCohort.through]).toBe(embedded.embeddedTransferCohort.rosterFile)
 })
 it('classifies every validator that fires during import and orders structural reads first',async()=>{
  const embedded=await import(new URL('../../../scripts/conversation-store/pglite-portable-source.mjs',import.meta.url).href)
  const head=await restore.loadPortableRoster(),cohort=await embedded.loadCohortRoster()
  for(const roster of [head,cohort]){
   const triggers=roster.triggers as Record<string,{class:string;function:string}>
   const afterCohortOrigin = 'require_conversation_record_retention_current'
   const afterCohortStructural = 'lock_conversation_anchor_policy_change'
   expect(roster.originValidators).toEqual((builder.originValidators as readonly string[]).filter(name => roster === head || name !== afterCohortOrigin))
   expect(roster.structuralValidators).toEqual(roster === head
    ? [...builder.structuralValidators, 'protect_configured_task_receipt', ...crmSummaryStructuralValidators]
    : (builder.structuralValidators as readonly string[]).filter(name => name !== afterCohortStructural))
   // The refused families: issuer checks under the nil import actor, linked rosters, goal scope, access migration.
   for(const key of ['application_clients.application_client_guard','application_access_grants.application_grant_guard','teamspace_members.teamspace_members_linked_roster_immutable',
    'workflow_runs.workflow_goal_scope_guard','workspace_access_migration_items.access_migration_guard','brain_row_versions.crm_privacy_write_admission'])
    expect(triggers[key].class).toBe('suspended:origin-validator')
   // A Team-bound session is inserted with its deferred context_group_id NULL.
   expect(triggers['sessions.sessions_context_binding_valid'].class).toBe('suspended:restoration-placeholder')
   // Structural checks keep firing, and pair invariants run once over the complete set.
   for(const key of ['tasks.tasks_responsibility_workspace_match_trg','native_turn_frames.native_turn_frame_pair','entities.crm_privacy_write_admission','memories.memories_context_scope_valid'])expect(triggers[key].class).toBe('fires')
   expect(triggers['scope_derivation_sources.scope_derivation_sources_retention'].class).toBe('suspended:contract-window')
   for(const {table,reads} of roster.validatorOrder as {table:string;reads:string[]}[])for(const read of reads)expect(roster.tables[read].class).not.toBe('derived')
  }
  expect(new Set([...builder.originValidators,...builder.structuralValidators]).size).toBe(builder.originValidators.length+builder.structuralValidators.length)
  expect(builder.readsRestorationPlaceholder('BEGIN IF NEW.context_group_id IS NOT NULL THEN RAISE EXCEPTION \'x\'; END IF; RETURN NEW; END',['context_group_id'])).toBe(true)
  expect(builder.readsRestorationPlaceholder("BEGIN IF to_jsonb(NEW)->>'a' IS NULL THEN RETURN NEW; END IF; RETURN NEW; END",['b'])).toBe(true)
  expect(builder.readsRestorationPlaceholder("BEGIN IF NEW.visibility='workspace' THEN RAISE EXCEPTION 'NEW row'; END IF; RETURN NEW; END",['context_group_id'])).toBe(false)
  expect(builder.tablesReadBy('BEGIN PERFORM 1 FROM public.workspaces w JOIN workspace_members m ON true, unnest(x) FROM jsonb_array_elements(y); END')).toEqual(['workspaces','workspace_members'])
 })
 it('detects every way a BEFORE INSERT body can change the inserted row',()=>{
  // The 8063 body, a validator that only compares, and the other reviewed shapes.
  expect(builder.assignsInsertedRow("BEGIN\n IF TG_OP='INSERT' THEN NEW.last_turn_lease_token:=NEW.turn_lease_token;\n END IF; RETURN NEW; END")).toBe(true)
  expect(builder.assignsInsertedRow("BEGIN IF NEW.status = 'revoked' AND NEW.id<>OLD.id THEN RAISE EXCEPTION 'x'; END IF; RETURN NEW; END")).toBe(false)
  expect(builder.assignsInsertedRow('BEGIN SELECT f.compartments, f.project_ids INTO NEW.compartments, NEW.project_ids FROM t f; RETURN NEW; END')).toBe(true)
  expect(builder.assignsInsertedRow('BEGIN SELECT x INTO y FROM t WHERE t.id=NEW.id; RETURN NEW; END')).toBe(false)
  expect(builder.assignsInsertedRow("BEGIN IF a THEN NEW.scope_held=true; END IF; RETURN NEW; END")).toBe(true)
  expect(builder.assignsInsertedRow('BEGIN NEW := jsonb_populate_record(NEW,x); RETURN NEW; END')).toBe(true)
  expect(builder.assignsInsertedRow('BEGIN RETURN COALESCE(NEW, OLD); END')).toBe(true)
  expect(builder.assignsInsertedRow('BEGIN -- NEW.x := 1;\n RETURN NEW; END')).toBe(false)
 })
 it('breaks reference cycles only at nullable references and refuses an unbreakable cycle',()=>{
  const edge=(child:string,parent:string,nullable:boolean,conname=child+'_'+parent)=>({child,parent,conname,columns:[parent+'_id'],nullable:[nullable]})
  const deferred=builder.chooseDeferredReferences([edge('users','workspaces',true),edge('workspaces','users',false),edge('sessions','workspaces',false)])
  expect(deferred).toEqual([{table:'users',constraint:'users_workspaces',parent:'workspaces',columns:['workspaces_id']}])
  expect(()=>builder.chooseDeferredReferences([edge('a','b',false),edge('b','a',false)])).toThrow('portable_roster_unbreakable_reference_cycle')
  expect(builder.stronglyConnected([edge('a','b',true),edge('b','c',true)])).toEqual([])
 })
 it('compares registry identity by signature roster only, never by installation-local records',()=>{
  const source=[{signature:'a()',record:'(1,a)'},{signature:'b()',record:'(2,b)'}]
  expect(record.compareExecutableRegistryRosters(source,[{signature:'a()',record:'(9,a)'},{signature:'b()',record:'(8,b)'}])).toBe(2)
  expect(()=>record.compareExecutableRegistryRosters(source,[{signature:'a()',record:'(9,a)'}])).toThrow('portable_restore_derived_roster_mismatch')
  expect(()=>record.compareExecutableRegistryRosters([{signature:'a()',record:'not a record'}],source)).toThrow('executable_registry_proof_malformed')
  expect(record.executableRegistryProofSql).toContain('native_turn_contract_helpers')
 })
})

describe('[COMP:api/portable-restore] archive authentication before any target query',()=>{
 async function archive(edit:(manifest:Record<string,any>)=>void=()=>{}){
  const root=await mkdtemp(join(tmpdir(),'portable-unit-'));scratch.push(root)
  const key=randomBytes(32),roster=await restore.loadPortableRoster()
  const durable=Object.entries(roster.tables as Record<string,{class:string}>).filter(([,entry])=>entry.class!=='derived').map(([name])=>name).sort()
  const manifest:Record<string,any>={format:restore.portableArchiveFormat,roster:{digest:roster.digest},
   tables:durable.map(name=>({name,file:null,rows:0,lineSha256:sha(''),recordSha256:sha('')}))}
  edit(manifest)
  await mkdir(join(root,'archive'));await sealJson(manifest,join(root,'archive','manifest.enc'),key)
  return{key,directory:join(root,'archive'),anchor:sha(JSON.stringify(manifest))}
 }
 const attempt=async(input:Awaited<ReturnType<typeof archive>>,overrides:Record<string,unknown>={})=>{
  const client=ownerOnly()
  const error=await restore.importPortableBrain({ownerClient:client,archiveDirectory:input.directory,key:input.key,expectedManifestSha256:input.anchor,...overrides}).catch((caught:unknown)=>caught)
  return{error:error as {code?:string},queries:client.queries}
 }
 it('refuses a missing anchor, a self-rehashed manifest and a wrong key',async()=>{
  const input=await archive()
  expect((await attempt(input,{expectedManifestSha256:undefined})).error.code).toBe('portable_restore_anchor_required')
  const rehashed=await attempt(input,{expectedManifestSha256:'0'.repeat(64)})
  expect(rehashed.error.code).toBe('portable_restore_archive_untrusted');expect(rehashed.queries).toHaveLength(1)
  expect((await attempt(input,{key:randomBytes(32)})).error.code).toBe('portable_restore_archive_untrusted')
 })
 it('refuses unknown, derived or missing archive tables and a different roster',async()=>{
  const unknown=await attempt(await archive(manifest=>{manifest.tables.push({name:'fictional_unreviewed_table',file:null,rows:0})}))
  expect(unknown.error.code).toBe('portable_restore_unknown_table');expect(unknown.queries).toHaveLength(1)
  expect((await attempt(await archive(manifest=>{manifest.tables.push({name:'native_turn_contract_helpers',file:null,rows:0})}))).error.code).toBe('portable_restore_unknown_table')
  expect((await attempt(await archive(manifest=>{manifest.tables.pop()}))).error.code).toBe('portable_restore_roster_mismatch')
  expect((await attempt(await archive(manifest=>{manifest.roster.digest='0'.repeat(64)}))).error.code).toBe('portable_restore_roster_mismatch')
 })
 it('refuses an elevated or busy owner before reading the archive',async()=>{
  const input=await archive()
  const busy={getTransactionStatus:()=>'T',query:async()=>{throw new Error('no query expected')}}
  expect((await restore.importPortableBrain({ownerClient:busy,archiveDirectory:input.directory,key:input.key,expectedManifestSha256:input.anchor}).catch((error:{code:string})=>error)).code)
   .toBe('portable_restore_requires_idle_owner')
  const elevated={getTransactionStatus:()=>'I',query:async()=>({rows:[{rolsuper:true,rolbypassrls:false,owns:true}]})}
  expect((await restore.importPortableBrain({ownerClient:elevated,archiveDirectory:input.directory,key:input.key,expectedManifestSha256:input.anchor}).catch((error:{code:string})=>error)).code)
   .toBe('portable_restore_requires_ordinary_owner')
 })
 it('withholds activation without a receipt-bound passing receiving proof',async()=>{
  const client=ownerOnly()
  const receipt={status:'imported',activation:'withheld',targetAuthentication:[]}
  const signed={...receipt,receiptSha256:sha(JSON.stringify(receipt))}
  for(const proof of [undefined,{status:'passed',checks:[],importReceiptSha256:signed.receiptSha256},
   {status:'passed',checks:[{name:'x',passed:false}],importReceiptSha256:signed.receiptSha256},{status:'passed',checks:[{name:'x',passed:true}],importReceiptSha256:'0'.repeat(64)}])
   await expect(restore.admitRestoredInstallation({ownerClient:client,importReceipt:signed,receivingProof:proof})).rejects.toThrow('portable_restore_activation_withheld')
  await expect(restore.admitRestoredInstallation({ownerClient:client,importReceipt:{...signed,receiptSha256:'0'.repeat(64)},receivingProof:{}})).rejects.toThrow('import receipt digest')
  expect(client.queries).toEqual([])
 })
 it('keeps the roster file the reviewed committed source',async()=>{
  const text=await readFile(new URL('portable-restore-roster.json',directory),'utf8')
  expect((await restore.loadPortableRoster()).digest).toBe(sha(text))
 })
})
