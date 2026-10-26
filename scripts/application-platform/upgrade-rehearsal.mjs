/** Real immutable fresh/upgrade migration rehearsal. [COMP:api/application-platform-acceptance] */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import pg from 'pg'
import { createLocalFixture, runCommand } from '../crm/local-fixture.mjs'

const [runId, mode, edition, pgBin, overlay] = process.argv.slice(2)
assert.match(runId ?? '', /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/)
assert.ok(['fresh','upgrade'].includes(mode)); assert.ok(['oss','overlay'].includes(edition))
assert.ok(pgBin); if (edition === 'overlay') assert.ok(overlay)
let interrupted=false
const onInterrupt=()=>{interrupted=true}
process.on('SIGTERM',onInterrupt);process.on('SIGINT',onInterrupt)
const output = resolve('output/application-platform', runId)
await mkdir(output, { recursive:true })

test(`[COMP:api/application-platform-acceptance] actual ${edition} ${mode} immutable migration rehearsal`, { timeout:120000 }, async () => {
  let fixture, reader, readerLoop, stop = false, readFailure
  const witness = { mode, edition, boundary:'8000_application_clients_and_grants.sql', callbacks:0, reads:[], ids:Object.fromEntries(['user','workspace','assistant','schema','record','company','person','link','approval','job'].map(key => [key,randomUUID()])) }
  const ids = witness.ids
  try {
    fixture = await createLocalFixture({ pgBin, runtimeRole:'app_user', migrationDirs:edition==='overlay'?[resolve(overlay)]:[], ...(mode==='upgrade'?{
      beforeApplyFile:witness.boundary,
      beforeApply:async ({ adminUrl,appUrl,file,appliedCount }) => {
        witness.callbacks++; assert.equal(file,witness.boundary); assert.ok(appliedCount>1)
        const owner = new pg.Client({ connectionString:adminUrl }); await owner.connect()
        try {
          assert.equal((await owner.query("SELECT to_regclass('public.application_clients') AS relation")).rows[0].relation,null)
          await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[ids.user])
          await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional upgrade workspace',$2)",[ids.workspace,ids.user])
          await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[ids.workspace,ids.user])
          await owner.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance) VALUES($1,'Fictional upgrade assistant',$2,$3,'primary','confidential')",[ids.assistant,ids.workspace,ids.user])
          await owner.query(`INSERT INTO entity_types(id,workspace_id,name,properties,created_by) VALUES($1,$2,'Fictional preserved requests','[{"name":"title","config":{"kind":"text"}}]',$3)`,[ids.schema,ids.workspace,ids.user])
          await owner.query(`INSERT INTO entity_instances(id,entity_type_id,workspace_id,data,created_by,last_edited_by) VALUES($1,$2,$3,'{"title":{"kind":"text","value":"Fictional legacy value"}}',$4,$4)`,[ids.record,ids.schema,ids.workspace,ids.user])
          for (const [id,kind] of [[ids.company,'company'],[ids.person,'person']]) await owner.query("INSERT INTO entities(id,kind,display_name,user_id,workspace_id,created_by_user_id,source) VALUES($1,$2,'Fictional legacy entity',$3,$4,$3,'manual')",[id,kind,ids.user,ids.workspace])
          await owner.query("INSERT INTO entity_links(id,source_kind,source_id,target_kind,target_id,edge_type,source,user_id,workspace_id) VALUES($1,'entity',$2,'entity',$3,'works_at','manual',$4,$5)",[ids.link,ids.person,ids.company,ids.user,ids.workspace])
          await owner.query(`INSERT INTO pending_approvals(id,workspace_id,approver_user_id,tool_name,kind,arguments,approval_payload) VALUES($1,$2,$3,'fictionalUpgradeOperation','workflow_step','{"preserved":true}','{"label":"Fictional queued approval"}')`,[ids.approval,ids.workspace,ids.user])
          await owner.query(`INSERT INTO scheduled_jobs(id,assistant_id,user_id,schedule,timezone,instructions,channel_type,channel_id,next_run_at) VALUES($1,$2,$3,'{"type":"interval","minutes":60}','UTC','Fictional preserved schedule','web','fictional-local-channel',now()+interval '1 day')`,[ids.job,ids.assistant,ids.user])
          witness.before = (await owner.query(`SELECT json_build_object(
            'record',(SELECT json_build_object('id',id,'data',data,'created_by',created_by) FROM entity_instances WHERE id=$1),
            'link',(SELECT json_build_object('id',id,'source_id',source_id,'target_id',target_id) FROM entity_links WHERE id=$2),
            'approval',(SELECT json_build_object('id',id,'status',status,'arguments',arguments,'approval_payload',approval_payload) FROM pending_approvals WHERE id=$3),
            'job',(SELECT json_build_object('id',id,'enabled',enabled,'schedule',schedule,'instructions',instructions,'next_run_at',next_run_at) FROM scheduled_jobs WHERE id=$4),
            'grant',(SELECT json_build_object('user_id',user_id,'role',role,'clearance',clearance) FROM workspace_members WHERE workspace_id=$5 AND user_id=$6)) AS state`,[ids.record,ids.link,ids.approval,ids.job,ids.workspace,ids.user])).rows[0].state
        } finally { await owner.end() }
        reader = new pg.Client({ connectionString:appUrl }); await reader.connect()
        await reader.query("SELECT set_config('app.current_user_id',$1,false)",[ids.user])
        const read = async () => {
          const result = await reader.query("SELECT id,data,to_regclass('public.application_clients') IS NOT NULL AS feature_present,current_user AS runtime_role FROM entity_instances WHERE id=$1",[ids.record])
          assert.equal(result.rows.length,1); assert.equal(result.rows[0].runtime_role,'app_user'); assert.equal(result.rows[0].data.title.value,'Fictional legacy value')
          witness.reads.push({ at:new Date().toISOString(),featurePresent:result.rows[0].feature_present,id:result.rows[0].id,runtimeRole:result.rows[0].runtime_role })
        }
        await read(); assert.equal(witness.reads[0].featurePresent,false)
        const deadline = Date.now()+90000
        readerLoop = (async () => { try { while(!stop) { assert.ok(Date.now()<deadline,'bounded old reader deadline exhausted'); await read(); await new Promise(resolve => setTimeout(resolve,5)) } } catch(error) { readFailure=error } })()
      },
    }:{}) })
    if(interrupted)throw Error('Owned upgrade rehearsal interrupted')
    if (mode==='upgrade') {
      await new Promise(resolve => setTimeout(resolve,20)); stop=true; await readerLoop; if(readFailure)throw readFailure
      assert.equal(witness.callbacks,1);assert.ok(witness.reads.length>=3);assert.ok(witness.reads.some(read=>read.featurePresent))
    }
    const path=join(output,`${edition}-${mode}-observation.json`)
    await writeFile(path,JSON.stringify(witness,null,2)+'\n',{mode:0o600})
    await runCommand('pnpm',['--filter','@use-brian/api','exec','vitest','run','--config','vitest.integration.config.ts',`src/application-platform/__tests__/${mode==='upgrade'?'upgrade':'qualification'}.integration.test.ts`,'--reporter=json',`--outputFile=${join(output,edition+'-'+mode+'-results.json')}`],{env:{...fixture.env,BRIAN_UPGRADE_OBSERVATION:path},inherit:true})
  } finally {
    stop=true;await readerLoop
    await writeFile(join(output,`${edition}-${mode}-last-observation.json`),JSON.stringify({...witness,readerError:readFailure?{code:readFailure.code??null,message:readFailure.message}:null},null,2)+'\n',{mode:0o600})
    try { await reader?.end();await fixture?.dispose() } finally { process.off('SIGTERM',onInterrupt);process.off('SIGINT',onInterrupt) }
  }
})
