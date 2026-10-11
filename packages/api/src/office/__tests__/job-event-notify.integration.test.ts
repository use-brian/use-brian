import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import type pg from 'pg'
import {getPool,getAppPool} from '../../db/client.js'
import {createOfficeGenerationStore} from '../../db/office-generation.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})

const store=createOfficeGenerationStore(async<T>(_user:string,sql:string,params:unknown[])=>({rows:(await pool.query(sql,params)).rows as T[]}))

async function fixture(patch:{status?:string;jobKind?:string;errorCode?:string|null}={}) {
  const user=randomUUID(),workspace=randomUUID(),artifact=randomUUID(),job=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[user])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Job notify fixture',$2)",[workspace,user])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspace,user])
  await pool.query(`INSERT INTO office_artifacts(id,workspace_id,family,mode,title,creator_user_id,owner_user_id,capability_version,sensitivity,default_workspace_role)
    VALUES($1,$2,'document','artifact','Notify fixture',$3,$3,1,'internal','view')`,[artifact,workspace,user])
  await pool.query(`INSERT INTO office_generation_jobs(id,workspace_id,artifact_id,initiated_by_user_id,job_kind,status,stage,brief,authority_projection,error_code,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,$6,'{}','{}',$7,$8)`,[job,workspace,artifact,user,patch.jobKind??'revise',patch.status??'queued',patch.errorCode??null,randomUUID()])
  // claim takes the oldest due job across the database; make this one first.
  await pool.query("UPDATE office_generation_jobs SET next_attempt_at=now()-interval '1 day'*(SELECT count(*) FROM office_generation_jobs) WHERE id=$1",[job])
  return {user,workspace,artifact,job}
}

async function listen(): Promise<{client:pg.PoolClient;payloads:Array<Record<string,unknown>>;close():Promise<void>}> {
  const client=await pool.connect()
  const payloads:Array<Record<string,unknown>>=[]
  client.on('notification',message=>{if(message.channel==='office_job_events'&&message.payload)payloads.push(JSON.parse(message.payload))})
  await client.query('LISTEN office_job_events')
  return {client,payloads,async close(){await client.query('UNLISTEN office_job_events');client.release()}}
}

async function settle(payloads:unknown[],count:number) {
  const started=Date.now()
  while(payloads.length<count&&Date.now()-started<2_000)await new Promise(resolve=>setTimeout(resolve,10))
}

const codes=async(job:string)=>(await pool.query<{code:string}>('SELECT code FROM office_generation_events WHERE job_id=$1 ORDER BY seq',[job])).rows.map(row=>row.code)

describe('[COMP:api/office-job-stream] migration 738 notify triggers',()=>{
  it('publishes an id-only pointer for an event insert and for a status update',async()=>{
    const f=await fixture()
    const listener=await listen()
    try {
      const event=await store.appendEvent({userId:f.user,jobId:f.job,workspaceId:f.workspace,code:'office.job.queued',values:{},actorType:'system'})
      await pool.query("UPDATE office_generation_jobs SET status='running' WHERE id=$1",[f.job])
      await pool.query('UPDATE office_generation_jobs SET updated_at=now() WHERE id=$1',[f.job])
      await settle(listener.payloads,2)
      await new Promise(resolve=>setTimeout(resolve,50))
      expect(listener.payloads.filter(payload=>payload.jobId===f.job)).toEqual([
        {jobId:f.job,workspaceId:f.workspace,seq:event.seq},
        {jobId:f.job,workspaceId:f.workspace,seq:null},
      ])
    } finally {await listener.close()}
  })
})

describe('[COMP:api/office-generation] every transition is an event',()=>{
  it('claim appends office.job.started in the same statement that sets running',async()=>{
    const f=await fixture()
    const job=await store.claim({userId:f.user,leaseToken:randomUUID(),leaseMs:60_000,jobKinds:['revise']})
    expect(job).toMatchObject({id:f.job,status:'running',workspaceId:f.workspace})
    const rows=(await pool.query('SELECT code,params,seq::int FROM office_generation_events WHERE job_id=$1',[f.job])).rows
    expect(rows).toEqual([{code:'office.job.started',params:{attempt:1},seq:1}])
  })

  it('finish appends the terminal event once, never duplicating a worker narration',async()=>{
    const narrated=await fixture()
    const lease=randomUUID()
    await store.claim({userId:narrated.user,leaseToken:lease,leaseMs:60_000,jobKinds:['revise']})
    await store.appendEvent({userId:narrated.user,jobId:narrated.job,workspaceId:narrated.workspace,code:'office.job.completed',values:{version:1},actorType:'system'})
    expect(await store.finish({userId:narrated.user,jobId:narrated.job,leaseToken:lease,status:'completed',stage:'completed'})).toBe(true)
    expect(await codes(narrated.job)).toEqual(['office.job.started','office.job.completed'])

    const bare=await fixture()
    const bareLease=randomUUID()
    await store.claim({userId:bare.user,leaseToken:bareLease,leaseMs:60_000,jobKinds:['revise']})
    await store.finish({userId:bare.user,jobId:bare.job,leaseToken:bareLease,status:'failed',stage:'failed',errorCode:'revision_failed'})
    expect((await pool.query('SELECT code,params FROM office_generation_events WHERE job_id=$1 ORDER BY seq',[bare.job])).rows)
      .toEqual([{code:'office.job.started',params:{attempt:1}},{code:'office.job.failed',params:{code:'revision_failed'}}])
  })

  it('a steering answer that resumes a paused job appends office.job.input_received',async()=>{
    const f=await fixture({jobKind:'create',status:'needs_input',errorCode:'material_fact_missing'})
    await store.steer({userId:f.user,workspaceId:f.workspace,jobId:f.job,instruction:'The audience is the finance team.'})
    expect((await pool.query('SELECT status FROM office_generation_jobs WHERE id=$1',[f.job])).rows[0].status).toBe('queued')
    expect(await codes(f.job)).toEqual(['office.job.input_received'])
  })
})
