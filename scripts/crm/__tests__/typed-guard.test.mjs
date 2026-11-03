import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { runtimeRoleSql } from '../runtime-role.mjs'
import { assertLocalFixture, cleanRuntimeEnvironment, createLocalFixture, runCommand } from '../local-fixture.mjs'

const signature='public.application_memory_statement_helpers_current()'
const phases=['prepare','transition','activate','verify']
const roleSql=phase=>runtimeRoleSql(phase,{password:phase==='activate'?'a'.repeat(64):undefined})
const aliases=[
 'read_admitted_native_scope_snapshot','read_entity_derivation_source',
 'read_admitted_native_scope_snapshot_before_knowledge_versions','read_entity_derivation_source_before_memory_successor',
 'read_admitted_native_scope_snapshot_before_persistent_context','read_entity_derivation_source_before_knowledge_versions',
 'read_admitted_native_scope_snapshot_before_public_share','read_entity_derivation_source_before_knowledge_source_parent',
 'read_entity_derivation_source_before_persistent_context','read_entity_derivation_source_before_engineering_archive',
]

test('[COMP:crm/assurance-fixture] Typed guard recognition refuses unknown code and metadata before invocation',async()=>{
 await assertLocalFixture()
 const owner=new pg.Client({connectionString:process.env.DATABASE_URL});await owner.connect()
 try{
  const original=(await owner.query('SELECT pg_get_functiondef(oid) AS definition,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0]
  for(const phase of phases) await owner.query(await roleSql(phase))
  for(const phase of phases)for(const change of ['body','constant true','constant false','trailing text','ACL','configuration','cost','helper body','untracked phase']){
   await owner.query('BEGIN')
   try{
    if(change==='body')await owner.query(original.definition.replace(original.prosrc,()=>"BEGIN RAISE EXCEPTION 'unsafe_guard_invoked'; END"))
    if(change==='constant true'||change==='constant false')await owner.query(original.definition.replace(original.prosrc,()=>`BEGIN RETURN ${change==='constant true'?'true':'false'}; END`))
    if(change==='trailing text')await owner.query(original.definition.replace(original.prosrc,()=>original.prosrc+'\n-- unknown guard text'))
    if(change==='ACL')await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO app_user`)
    if(change==='configuration')await owner.query(`ALTER FUNCTION ${signature} SET search_path=public`)
    if(change==='cost')await owner.query(`ALTER FUNCTION ${signature} COST 101`)
    if(change==='helper body'){
     const helper=(await owner.query("SELECT pg_get_functiondef(oid) AS definition,prosrc FROM pg_proc WHERE oid='application_session_eval_field(uuid,uuid,text,jsonb)'::regprocedure")).rows[0]
     await owner.query(helper.definition.replace(helper.prosrc,()=>helper.prosrc+'\n-- unknown helper text'))
    }
    if(change==='untracked phase')await owner.query("DELETE FROM _migrations WHERE name='8155_native_validation_query_plans.sql'")
    await assert.rejects(owner.query(await roleSql(phase)),/Unknown fixture Memory guard/,`${change}:${phase}`)
   }finally{await owner.query('ROLLBACK')}
   assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current,true)
  }
 }finally{
  await owner.query(await runtimeRoleSql('activate',{password:decodeURIComponent(new URL(process.env.DATABASE_URL_APP).password)}))
  await owner.end()
 }
})

test('[COMP:crm/assurance-fixture] Typed guard retains only the existing reviewed alias cleanup',async()=>{
 await assertLocalFixture()
 const owner=new pg.Client({connectionString:process.env.DATABASE_URL});await owner.connect()
 try{
  await owner.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='assurance_app') THEN CREATE ROLE assurance_app NOLOGIN;END IF;END $$")
  for(const name of aliases)await owner.query(`GRANT EXECUTE ON FUNCTION public.${name}(uuid,text,uuid) TO assurance_app`)
  assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current,false)
  await owner.query(await roleSql('transition'))
  assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current,true)
  for(const name of aliases)assert.equal((await owner.query("SELECT has_function_privilege('assurance_app',$1,'EXECUTE') AS allowed",[`public.${name}(uuid,text,uuid)`])).rows[0].allowed,false)
  await owner.query('BEGIN')
  try{
   await owner.query('GRANT EXECUTE ON FUNCTION application_session_eval_field(uuid,uuid,text,jsonb) TO assurance_app')
   await assert.rejects(owner.query(await roleSql('transition')),/Unknown fixture Memory guard/)
  }finally{await owner.query('ROLLBACK')}
 }finally{await owner.end()}
})

test('[COMP:crm/assurance-fixture] Source edge typed guard accepts only its exact private member',async()=>{
 await assertLocalFixture()
 const owner=new pg.Client({connectionString:process.env.DATABASE_URL});await owner.connect()
 const helperSignature='public.application_native_source_edges_dispatch(uuid,text,uuid,text)'
 try{
  assert.match((await owner.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0].prosrc,/count\(\*\)=128/)
  for(const phase of phases)for(const change of ['body','cost','ACL','untracked phase']){
   await owner.query('BEGIN')
   try{
    if(change==='body'){
     const helper=(await owner.query('SELECT pg_get_functiondef(oid) definition,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[helperSignature])).rows[0]
     await owner.query(helper.definition.replace(helper.prosrc,()=>"BEGIN RAISE EXCEPTION 'unsafe_edge_dispatch_invoked'; END"))
    }
    if(change==='cost')await owner.query(`ALTER FUNCTION ${helperSignature} COST 101`)
    if(change==='ACL')await owner.query(`GRANT EXECUTE ON FUNCTION ${helperSignature} TO app_user`)
    if(change==='untracked phase')await owner.query("DELETE FROM _migrations WHERE name='8168_native_source_edge_dispatch.sql'")
    await assert.rejects(owner.query(await roleSql(phase)),/Unknown fixture Memory guard/,`${change}:${phase}`)
   }finally{await owner.query('ROLLBACK')}
   assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() current')).rows[0].current,true)
  }
 }finally{await owner.end()}
})

test('[COMP:crm/assurance-fixture] Original SQL guard phase remains recognized before typed migration',{timeout:180_000},async()=>{
 await assertLocalFixture()
 const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
 for(const beforeApplyFile of ['8128_native_memory_history_admission.sql','8129_native_history_title_dependencies.sql','8155_native_validation_query_plans.sql']){
 let checked=false
 const fixture=await createLocalFixture({pgBin,env,beforeApplyFile,beforeApply:async({adminUrl})=>{
  const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
  try{
   assert.equal((await owner.query('SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=$1::regprocedure',[signature])).rows[0].lanname,'sql')
   for(const phase of phases)await owner.query(await roleSql(phase))
   checked=true
  }finally{await owner.end()}
 }})
 try{assert.equal(checked,true)}finally{await fixture.dispose()}
 }
})


test('[COMP:crm/assurance-fixture] Typed migration refuses prerequisite drift without repinning',{timeout:180_000},async()=>{
 await assertLocalFixture()
 const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
 const raw=await readFile(new URL('../../../packages/api/migrations/8155_native_validation_query_plans.sql',import.meta.url),'utf8')
 const migration=raw.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
 let checked=0
 const fixture=await createLocalFixture({pgBin,env,beforeApplyFile:'8155_native_validation_query_plans.sql',beforeApply:async({adminUrl})=>{
  const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
  try{
   for(const change of ['guard body','guard cost','guard ACL','recording body','recording ACL','ancestry owner']){
    await owner.query('BEGIN')
    try{
     if(change.endsWith('body')){
      const target=change==='guard body'?signature:'public.recording_source_read_allowed(uuid,text,uuid)'
      const fn=(await owner.query('SELECT pg_get_functiondef(oid) AS definition,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[target])).rows[0]
      await owner.query(fn.definition.replace(fn.prosrc,()=>fn.prosrc+'\n-- synthetic prerequisite drift'))
     }
     if(change==='guard cost')await owner.query(`ALTER FUNCTION ${signature} COST 101`)
     if(change==='guard ACL')await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO app_user`)
     if(change==='recording ACL'){
      await owner.query('CREATE ROLE synthetic_guard_reader NOLOGIN')
      await owner.query('GRANT EXECUTE ON FUNCTION recording_source_read_allowed(uuid,text,uuid) TO synthetic_guard_reader')
     }
     if(change==='ancestry owner')await owner.query('ALTER FUNCTION scope_source_ancestors_before_browser_profile(uuid,text,uuid) OWNER TO app_user')
     await assert.rejects(owner.query(migration),/Native query-plan prerequisite changed/,change)
     checked++
    }finally{await owner.query('ROLLBACK')}
    assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current,true)
   }
  }finally{await owner.end()}
 }})
 try{assert.equal(checked,6)}finally{await fixture.dispose()}
})
