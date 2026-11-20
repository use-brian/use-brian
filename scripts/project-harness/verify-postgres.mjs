#!/usr/bin/env node
/** Explicit disposable PostgreSQL 18 verification. Never consumes a supplied DB URL. */
import { randomUUID } from 'node:crypto'
import { deepStrictEqual } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import pg from 'pg'
import { assertLocalFixture, cleanRuntimeEnvironment, createLocalFixture, runCommand, validateAmbientDatabase } from '../crm/local-fixture.mjs'

export function parseVerifyArguments(args) {
  if(args.length!==2||args[0]!=='--pg-bin'||!args[1]||args[1].startsWith('--')) {
    throw new Error('Usage: node scripts/project-harness/verify-postgres.mjs --pg-bin /path/to/postgresql18/bin')
  }
  return args[1]
}
// Equality witness only: never an authentication root or registry rebaseline.
const canonicalSql=`SELECT encode(sha256(convert_to(jsonb_build_object(
  'registry',(SELECT jsonb_agg(to_jsonb(h) ORDER BY signature) FROM native_turn_contract_helpers h),
  'members',(SELECT jsonb_agg(to_jsonb(p) ORDER BY h.signature) FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid=(h.contract).oid),
  'retained',(SELECT jsonb_agg(to_jsonb(h) ORDER BY signature) FROM native_retained_contract_helpers h)
)::text,'UTF8')),'hex') digest`
const api=fileURLToPath(new URL('../../packages/api/',import.meta.url))
const suites=['src/db/__tests__/project-harness.integration.test.ts','src/migrations/__tests__/project-harness-successors.integration.test.ts']
const snapshotSql=`SELECT jsonb_build_object(
  'products',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_harness_products x WHERE workspace_id=$1),'[]'::jsonb),
  'components',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_harness_components x WHERE workspace_id=$1),'[]'::jsonb),
  'revisions',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_harness_revisions x WHERE workspace_id=$1),'[]'::jsonb)
) snapshot`

async function seedBefore8330({env}) {
  await assertLocalFixture(env)
  const c=new pg.Client({connectionString:env.DATABASE_URL,statement_timeout:15000})
  await c.connect()
  try {
    if((await c.query("SELECT to_regclass('public.project_harness_approvals') present")).rows[0].present!==null) throw new Error('Upgrade boundary was not before 8330')
    const workspaceId=randomUUID(),userId=randomUUID()
    await c.query('BEGIN')
    await c.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'Synthetic upgrade owner')",[userId])
    await c.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Synthetic pre8330 harness',$2)",[workspaceId,userId])
    await c.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','internal')",[workspaceId,userId])
    await c.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=true WHERE id=$1',[workspaceId])
    await c.query("SELECT set_config('app.current_user_id',$1,true)",[userId])
    const projectId=(await c.query("SELECT project_shared_create($1,'Pre8330',NULL,NULL,'{}'::uuid[],'{}'::uuid[]) id",[workspaceId])).rows[0].id
    const productId=(await c.query('SELECT project_harness_write_node($1,$2,NULL,NULL,$3,0) node',[workspaceId,projectId,{name:'Existing Product'}])).rows[0].node.id
    const componentId=(await c.query('SELECT project_harness_write_node($1,$2,$3,NULL,$4,0) node',[workspaceId,projectId,productId,{name:'Existing Component'}])).rows[0].node.id
    const definition={schemaVersion:1,rules:[],codeChecks:[],acceptanceScenarios:[{key:'upgrade',title:'Preserved specification',preconditions:['Ready'],steps:['Observe'],criteria:[{key:'preserved',observation:'Unchanged',evidence:'Observation'}]}]}
    const revisionIds=[]
    for(const expected of [0,1]) {
      const row=(await c.query('SELECT project_harness_put($1,$2,$3,$4,$5,$6) revision',[workspaceId,projectId,productId,componentId,expected,definition])).rows[0].revision
      revisionIds.push(row.id)
    }
    const snapshot=(await c.query(snapshotSql,[workspaceId])).rows[0].snapshot
    await c.query('COMMIT')
    return {workspaceId,userId,projectId,productId,componentId,revisionIds,snapshot}
  } catch(error) { await c.query('ROLLBACK').catch(()=>{}); throw error }
  finally { await c.end() }
}

// Negative fixtures only: this does not authenticate or upgrade an old candidate.
async function verifyCandidateRefusal(fixture, marker) {
  await assertLocalFixture(fixture.env)
  const c=new pg.Client({connectionString:fixture.adminUrl,statement_timeout:15000})
  await c.connect()
  try {
    if(marker==='ledger') await c.query("INSERT INTO _migrations(name) VALUES('8272_native_helper_attestation_cost.sql')")
    else await c.query("CREATE TABLE public.native_turn_helper_attestations(signature text); INSERT INTO public.native_turn_helper_attestations VALUES('preserve-candidate-marker')")
    const preservationSql=`SELECT jsonb_build_object(
      'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY name) FROM _migrations m),
      'native',(${canonicalSql}),
      'compiler',to_regclass('public.native_turn_helper_attestations')::oid,
      'admission',(SELECT prosrc FROM pg_proc WHERE oid='public.require_session_creation_admission()'::regprocedure)
    ) snapshot`
    const before=(await c.query(preservationSql)).rows[0].snapshot
    const {tsImport}=await import('tsx/esm/api')
    const {runMigrations}=await tsImport('../../packages/api/scripts/migrate.ts',import.meta.url)
    let refused=false
    try { await runMigrations({databaseUrl:fixture.adminUrl}) }
    catch(error) {
      if(!String(error.message).includes('project_harness_candidate_upgrade_unsupported')) throw error
      refused=true
    }
    if(!refused) throw new Error('Historical candidate marker was not refused')
    deepStrictEqual((await c.query(preservationSql)).rows[0].snapshot,before,'Refusal changed candidate state')
    if(marker!=='ledger') deepStrictEqual((await c.query('SELECT signature FROM public.native_turn_helper_attestations')).rows,[{signature:'preserve-candidate-marker'}])
  } finally { await c.end() }
}

export async function verifyProjectHarness(args, env) {
const pgBin=parseVerifyArguments(args)
validateAmbientDatabase(env)
const runtime=cleanRuntimeEnvironment(env)
for(const mode of ['fresh','develop-tip','upgrade']) {
  let fixture, witness, canonicalBefore
  try {
    console.log(`Project harness PostgreSQL: ${mode}, full replay as ordinary owner`)
    fixture=await createLocalFixture({pgBin,env:runtime,ordinaryOwner:true,migrationProgress:true,
      ...(mode==='upgrade'?{beforeApplyFile:'8330_project_harness_verification.sql',beforeApply:async boundary=>{witness=await seedBefore8330(boundary)}}:{}),
      ...(mode==='develop-tip'?{beforeApplyFile:'8329_project_harnesses.sql',beforeApply:async ({env})=>{
        await assertLocalFixture(env)
        const c=new pg.Client({connectionString:env.DATABASE_URL,statement_timeout:15000})
        await c.connect()
        try {
          if((await c.query("SELECT to_regclass('public.project_harness_products') present")).rows[0].present!==null) throw new Error('Develop-tip boundary already has harness effects')
          if((await c.query("SELECT name FROM _migrations WHERE name='8328_conversation_graph_frontier.sql'")).rows.length!==1) throw new Error('Missing develop-tip receipt')
          canonicalBefore=(await c.query(canonicalSql)).rows[0].digest
        } finally { await c.end() }
      }}:{}),
    })
    await assertLocalFixture(fixture.env)
    if(mode==='upgrade') {
      if(!witness) throw new Error('Upgrade witness was not created')
      const c=new pg.Client({connectionString:fixture.adminUrl,statement_timeout:15000})
      await c.connect()
      try { deepStrictEqual((await c.query(snapshotSql,[witness.workspaceId])).rows[0].snapshot,witness.snapshot,'8330 changed preexisting hierarchy/history') }
      finally { await c.end() }
    }
    if(mode==='develop-tip') {
      if(!canonicalBefore) throw new Error('Develop-tip witness was not captured')
      const c=new pg.Client({connectionString:fixture.adminUrl,statement_timeout:15000})
      await c.connect()
      try { deepStrictEqual((await c.query(canonicalSql)).rows[0].digest,canonicalBefore,'Harness successors changed native contracts') }
      finally { await c.end() }
    }
    await runCommand('corepack',['pnpm','exec','vitest','run','--config','vitest.integration.config.ts','--no-file-parallelism','--maxWorkers=1',...suites],{
      cwd:api,inherit:true,env:{...fixture.env,PG_STATEMENT_TIMEOUT_MS:'15000',BRIAN_HARNESS_REPLAY_MODE:mode,
        ...(witness?{BRIAN_HARNESS_UPGRADE_SEED:JSON.stringify({...witness,snapshot:undefined})}:{}),
      },
    })
    // Commit a synthetic historical marker only after positive verification;
    // the actual runner must refuse it and leave it until fixture disposal.
    if(mode==='fresh') await verifyCandidateRefusal(fixture,'ledger')
    if(mode==='develop-tip') await verifyCandidateRefusal(fixture,'effects')
    console.log(`Project harness PostgreSQL: ${mode} passed`)
  } finally { if(fixture) await fixture.dispose() }
}
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  await verifyProjectHarness(process.argv.slice(2),process.env)
}
