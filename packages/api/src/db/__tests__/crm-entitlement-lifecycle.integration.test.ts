import {randomUUID} from 'node:crypto'
import {setImmediate} from 'node:timers/promises'
import {afterAll,describe,expect,it} from 'vitest'
import type {CrmOperationsContext} from '@use-brian/core/crm/operations-types.js'
import {getPool} from '../client.js'
import {createWorkspaceModulesStore} from '../workspace-modules-store.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createCrmEntitlementWorker} from '../../crm-operations/entitlement-worker.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),store=createDbCrmOperationsStore(),service=createCrmOperationsService(store)
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID(),planId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Lifecycle fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional person',$3,'manual')",[contactId,workspaceId,userId])
  await pool.query("INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,$2,'member','Member','USD',0,'manual')",[planId,workspaceId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'system_job',job:'entitlement_expiry',runId:randomUUID()},authority:{role:'owner',canConfigure:false,canWrite:true,trustedIdentitySources:[]}}
  async function grant(status='active',end:string|null='2001-01-01T00:00:00Z',provider:string|null=null) {
    const id=randomUUID()
    await pool.query(`INSERT INTO association_memberships(id,workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at,provider,provider_membership_id)
      VALUES($1::uuid,$2,$3,$4,$1::text,repeat('a',64),$5,'2000-01-01T00:00:00Z',$6,$7,CASE WHEN $7::text IS NULL THEN NULL ELSE $1::text END)`,[id,workspaceId,contactId,planId,status,end,provider])
    return id
  }
  const expire=(id:string)=>service.execute(context,{kind:'expire_due_entitlement',entitlementId:id})
  const events=async()=>Number((await pool.query("SELECT count(*) count FROM crm_domain_event_outbox WHERE workspace_id=$1 AND event_type='crm.entitlement.changed'",[workspaceId])).rows[0].count)
  return {workspaceId,userId,contactId,planId,context,grant,expire,events}
}
describe('[COMP:crm/entitlement-lifecycle] Actual canonical expiry and row races',()=>{
  afterAll(async()=>{_resetCoalescerForTests();await pool.end()})
  it('expires all 105 due manual grants independently of the disabled module and emits one event each',async()=>{
    const f=await fixture();expect((await createWorkspaceModulesStore().get(f.workspaceId, 'association')).state).toBe('disabled')
    for(let i=0;i<105;i++)await f.grant()
    await createCrmEntitlementWorker().tick()
    expect((await pool.query("SELECT count(*)::int count FROM association_memberships WHERE workspace_id=$1 AND status='expired'",[f.workspaceId])).rows[0].count).toBe(105)
    expect(await f.events()).toBe(105)
    await createCrmEntitlementWorker().tick();expect(await f.events()).toBe(105)
  })
  it('leaves provider-managed, indefinite, future and terminal rows unchanged',async()=>{
    const f=await fixture(),ids=[await f.grant('active','2001-01-01T00:00:00Z','fixture_provider'),await f.grant('active',null),await f.grant('active','2099-01-01T00:00:00Z'),await f.grant('cancelled'),await f.grant('expired'),await f.grant('pending')]
    for(const id of ids)expect((await f.expire(id)).record.changed).toBe(false)
    expect((await f.expire(randomUUID())).duplicate).toBe(true);expect(await f.events()).toBe(0)
    const denied=(await pool.query("SELECT crm_entitlement_is_effective(status,starts_at,ends_at,clock_timestamp()) effective FROM association_memberships WHERE id=$1",[ids[0]])).rows[0]
    expect(denied.effective).toBe(false)
  })
  it('serializes two expiry workers and replays one committed transition',async()=>{
    const f=await fixture(),id=await f.grant()
    const results=await Promise.all([f.expire(id),f.expire(id)])
    expect(results.filter(r=>r.record.changed===true)).toHaveLength(1);expect(await f.events()).toBe(1)
    expect((await f.expire(id)).duplicate).toBe(true)
    expect((await pool.query("SELECT count(*)::int count FROM association_audit_log WHERE workspace_id=$1 AND action='crm.entitlement.changed'",[f.workspaceId])).rows[0].count).toBe(1)
  })
  it('rechecks a stale candidate after a concurrent extension commits',async()=>{
    const f=await fixture(),id=await f.grant(),writer=await pool.connect()
    let pending:ReturnType<typeof f.expire>|undefined
    try {
      await writer.query('BEGIN');await writer.query("UPDATE association_memberships SET ends_at='2099-01-01T00:00:00Z' WHERE id=$1",[id])
      pending=f.expire(id)
      let waiting=false
      for(let i=0;i<100;i++) {
        const locks=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM association_memberships%' LIMIT 1")
        if(locks.rowCount){waiting=true;break}await setImmediate()
      }
      expect(waiting).toBe(true)
      await writer.query('COMMIT')
      expect((await pending).record.changed).toBe(false);expect(await f.events()).toBe(0)
      expect((await pool.query('SELECT status FROM association_memberships WHERE id=$1',[id])).rows[0].status).toBe('active')
    }finally{await writer.query('ROLLBACK').catch(()=>{});writer.release();if(pending)await pending}
  })
  it('rolls back expiry when its event cannot commit, then succeeds once on retry',async()=>{
    const f=await fixture(),id=await f.grant()
    await pool.query("ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT fixture_refuse_expiry CHECK(event_key NOT LIKE '%:expired') NOT VALID")
    try {
      await expect(f.expire(id)).rejects.toThrow()
      expect((await pool.query('SELECT status FROM association_memberships WHERE id=$1',[id])).rows[0].status).toBe('active')
      expect(await f.events()).toBe(0)
    }finally{await pool.query('ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT fixture_refuse_expiry')}
    expect((await f.expire(id)).record.changed).toBe(true);expect(await f.events()).toBe(1)
  })
  it('rejects a member expiry shortcut and cannot cross the workspace boundary',async()=>{
    const f=await fixture(),other=await fixture(),id=await other.grant()
    expect((await f.expire(id)).record.changed).toBe(false)
    await expect(service.execute({...f.context,actor:{kind:'user',userId:f.userId}},{kind:'expire_due_entitlement',entitlementId:id})).rejects.toMatchObject({code:'not_authorized'})
    await expect(store.transaction(f.context,tx=>tx.updateEntitlement(id,{status:'expired'}))).rejects.toMatchObject({code:'not_authorized'})
  })
})
