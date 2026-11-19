#!/usr/bin/env node
/** Explicit disposable PostgreSQL 18 verification. Never consumes a supplied DB URL. */
import { randomUUID } from 'node:crypto'
import { deepStrictEqual } from 'node:assert'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { assertLocalFixture, cleanRuntimeEnvironment, createLocalFixture, runCommand, validateAmbientDatabase } from '../crm/local-fixture.mjs'

const args=process.argv.slice(2)
if(args.length!==2||args[0]!=='--pg-bin'||!args[1]||args[1].startsWith('--')) {
  throw new Error('Usage: node scripts/project-harness/verify-postgres.mjs --pg-bin /path/to/postgresql18/bin')
}
validateAmbientDatabase(process.env)
// Drop all inherited connection/auth/runtime configuration, even loopback URLs.
const runtime=cleanRuntimeEnvironment(process.env), pgBin=args[1]
const api=fileURLToPath(new URL('../../packages/api/',import.meta.url))
const suite='src/db/__tests__/project-harness.integration.test.ts'
const snapshotSql=`SELECT jsonb_build_object(
  'products',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_harness_products x WHERE workspace_id=$1),'[]'::jsonb),
  'components',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_harness_components x WHERE workspace_id=$1),'[]'::jsonb),
  'revisions',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_harness_revisions x WHERE workspace_id=$1),'[]'::jsonb)
) snapshot`

async function seedBefore8270({env}) {
  await assertLocalFixture(env)
  const c=new pg.Client({connectionString:env.DATABASE_URL,statement_timeout:15000})
  await c.connect()
  try {
    if((await c.query("SELECT to_regclass('public.project_harness_approvals') present")).rows[0].present!==null) throw new Error('Upgrade boundary was not before 8270')
    const workspaceId=randomUUID(),userId=randomUUID()
    await c.query('BEGIN')
    await c.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'Synthetic upgrade owner')",[userId])
    await c.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Synthetic pre8270 harness',$2)",[workspaceId,userId])
    await c.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','internal')",[workspaceId,userId])
    await c.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=true WHERE id=$1',[workspaceId])
    await c.query("SELECT set_config('app.current_user_id',$1,true)",[userId])
    const projectId=(await c.query("SELECT project_shared_create($1,'Pre8270',NULL,NULL,'{}'::uuid[],'{}'::uuid[]) id",[workspaceId])).rows[0].id
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

for(const mode of ['fresh','upgrade']) {
  let fixture, witness
  try {
    console.log(`Project harness PostgreSQL: ${mode}, full replay as ordinary owner`)
    fixture=await createLocalFixture({pgBin,env:runtime,ordinaryOwner:true,migrationProgress:true,
      ...(mode==='upgrade'?{beforeApplyFile:'8270_project_harness_verification.sql',beforeApply:async boundary=>{witness=await seedBefore8270(boundary)}}:{}),
    })
    await assertLocalFixture(fixture.env)
    if(mode==='upgrade') {
      if(!witness) throw new Error('Upgrade witness was not created')
      const c=new pg.Client({connectionString:fixture.adminUrl,statement_timeout:15000})
      await c.connect()
      try { deepStrictEqual((await c.query(snapshotSql,[witness.workspaceId])).rows[0].snapshot,witness.snapshot,'8270 changed preexisting hierarchy/history') }
      finally { await c.end() }
    }
    await runCommand('corepack',['pnpm','exec','vitest','run','--config','vitest.integration.config.ts','--no-file-parallelism','--maxWorkers=1',suite],{
      cwd:api,inherit:true,env:{...fixture.env,PG_STATEMENT_TIMEOUT_MS:'15000',BRIAN_HARNESS_REPLAY_MODE:mode,
        ...(witness?{BRIAN_HARNESS_UPGRADE_SEED:JSON.stringify({...witness,snapshot:undefined})}:{}),
      },
    })
    console.log(`Project harness PostgreSQL: ${mode} passed`)
  } finally { if(fixture) await fixture.dispose() }
}
