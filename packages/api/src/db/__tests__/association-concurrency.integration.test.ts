import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import {setTimeout} from 'node:timers/promises'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {createDbDocEntityStore} from '../doc-entity-store.js'
import {getPool,getAppPool,applyRLSGucs} from '../client.js'
import {createAssociationWorkspaceModulesStore,finishAssociationDrain} from '../../association/workspace-module.js'
import {createAssociationStore} from '../association-store.js'
import {createAssociationService} from '../../association/service.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createAssociationLifecycleWorker} from '../../association/lifecycle-worker.js'
import {EventInputSchema,TicketInputSchema,OrderCreateSchema} from '../../association/domain.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),modules=createAssociationWorkspaceModulesStore(),commerce=createAssociationStore(),service=createAssociationService({crmService:createCrmOperationsService(createDbCrmOperationsStore())})
const protectedWorkspaces:string[]=[]
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Reservation fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional attendee',$3,'manual')",[contactId,workspaceId,userId])
  const assistantId=randomUUID()
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional drain assistant',$2,$3,'primary','internal')",[assistantId,userId,workspaceId])
  const records=createDbDocEntityStore({actorUserId:userId})
  const schema=await records.createEntityType({workspaceId,name:'Fictional drain ownership',properties:[{name:'title',config:{kind:'text'}}],createdBy:userId})
  const ownedRow=await records.createEntity({workspaceId,entityTypeId:schema.id,data:{title:{kind:'text',value:'Fictional owned row'}},sourceApp:'api',createdBy:userId,lastEditedBy:userId})
  await pool.query("INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,jsonb_build_object('kind','generic','entityTypeId',$2::text),'record.'||$2::text,'association')",[workspaceId,schema.id])
  protectedWorkspaces.push(workspaceId)
  await modules.act(workspaceId, userId, 'association', {action:'enable',expectedVersion:1})
  const actor={credentialKind:'user' as const,credentialId:userId,actingUserId:userId}
  const event=await commerce.upsertEvent(workspaceId,EventInputSchema.parse({slug:'fixture-event',title:'Fixture event',startsAt:'2099-01-01T12:00:00Z',endsAt:'2099-01-01T14:00:00Z',timezone:'UTC',mode:'venue',status:'published',capacity:1000}),actor)
  const ticket=await commerce.upsertTicket(workspaceId,String(event.record.id),TicketInputSchema.parse({key:'standard',name:'Standard',currency:'USD',priceMinor:0,status:'on_sale',capacity:1000}),actor)
  const context={workspaceId,actor:{kind:'system_job' as const,job:'association_expiry' as const,runId:randomUUID()},authority:{role:'owner' as const,canConfigure:false,canRead:true,canWrite:true,canReconcileProvider:false,trustedIdentitySources:[]}}
  async function order(due=true) {
    const result=await commerce.createOrder(workspaceId,OrderCreateSchema.parse({contactId,idempotencyKey:randomUUID(),lines:[{ticketId:ticket.record.id,quantity:1,attendees:[{name:'Fictional attendee'}]}]}),actor)
    const id=String(result.record.id)
    if(due)await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id])
    return id
  }
  const expire=(id:string)=>service.execute(context,{kind:'expire_due_order',orderId:id})
  const drain=async()=>modules.act(workspaceId, userId, 'association', {action:'request_disable',expectedVersion:(await modules.get(workspaceId, 'association')).version})
  return {workspaceId,userId,assistantId,ownedRow,context,actor,order,expire,drain}
}
async function blocked(fragment:string) {
  const deadline=Date.now()+5000
  while(Date.now()<deadline) {
    if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0",[fragment])).rowCount)return
    await setTimeout(10)
  }
  throw Error('Expected a database row-lock wait')
}
// Pause only after an actual SQL boundary on the supplied connection.
function schedulingPool(base:Pool,match:(sql:string)=>boolean) {
  let reached!:()=>void,release!:()=>void,pid=0,armed=true
  const ready=new Promise<void>(resolve=>{reached=resolve}),pause=new Promise<void>(resolve=>{release=resolve})
  const scheduled={connect:async()=>{
    const client=await base.connect();pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    return new Proxy(client,{get(target,key){
      const value=Reflect.get(target,key)
      if(key==='query')return async(...args:unknown[])=>{
        const result=await Reflect.apply(value,target,args)
        if(armed && typeof args[0]==='string' && match(args[0])){armed=false;reached();await pause}
        return result
      }
      return typeof value==='function'?value.bind(target):value
    }})
  }} as unknown as Pool
  return {pool:scheduled,ready,release:()=>release(),pid:()=>pid}
}
async function waiter(blocker:number,fragment:string) {
  const deadline=Date.now()+5000
  while(Date.now()<deadline){
    const rows=(await pool.query(`SELECT a.pid,a.query,pg_blocking_pids(a.pid) AS blockers,
      EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='workspace_modules'::regclass AND l.mode='RowShareLock' AND l.granted) AS module_share
      FROM pg_stat_activity a WHERE a.datname=current_database() AND a.wait_event_type='Lock'
       AND $1=ANY(pg_blocking_pids(a.pid)) AND position($2 in a.query)>0`,[blocker,fragment])).rows
    if(rows[0]){expect(rows[0].module_share).toBe(true);console.info('[association drain] actual module waiter',JSON.stringify(rows[0]));return rows[0]}
    await setTimeout(10)
  }
  throw Error('Expected actual module blocker')
}
async function drainSnapshot(workspaceId:string) {
  return (await pool.query(`SELECT
    (SELECT to_jsonb(m) FROM workspace_modules m WHERE workspace_id=$1 AND module_key='association') AS module,
    (SELECT revision::text FROM application_policy_workspace_epochs WHERE workspace_id=$1) AS epoch,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM workspace_audit_log a WHERE workspace_id=$1) AS audit,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY transaction_id,backend_pid),'[]') FROM application_native_module_lifecycle_reviews r WHERE workspace_id=$1) AS witnesses`,[workspaceId])).rows[0]
}
describe('[COMP:crm/association-lifecycle] Actual reservation expiry and durable drain',()=>{
  beforeAll(async()=>{
    expect((await appPool.query(`SELECT session_user,current_user,rolsuper,rolbypassrls,
      pg_get_userbyid(c.relowner)=session_user AS owns_modules FROM pg_roles r CROSS JOIN pg_class c
      WHERE r.rolname=session_user AND c.oid='workspace_modules'::regclass`)).rows[0])
      .toEqual({session_user:'app_user',current_user:'app_user',rolsuper:false,rolbypassrls:false,owns_modules:false})
    await pool.query(`CREATE FUNCTION association_drain_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE s public.entity_types;keys jsonb;fields jsonb;BEGIN
       SELECT * INTO s FROM public.entity_types WHERE workspace_id=w AND id=(o->>'entityTypeId')::uuid;
       IF s.id IS NULL OR t<>'record.'||s.id::text THEN RETURN NULL;END IF;
       SELECT jsonb_agg(p->'name' ORDER BY p->>'name'),jsonb_agg(jsonb_build_object('key',p->>'name','read','[]'::jsonb,'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY p->>'name') INTO keys,fields FROM jsonb_array_elements(s.properties) p;
       RETURN jsonb_build_object('moduleKey','association','origin',o,'typeKey',t,'schemaVersion',s.schema_version::text,'policyVersion','1','fieldKeys',keys,'fields',fields,
        'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));END $$;
      REVOKE ALL ON FUNCTION association_drain_fixture_catalog(uuid,jsonb,text) FROM PUBLIC;
      CREATE FUNCTION association_drain_fixture_metadata(w uuid,o jsonb,t text,i text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE catalog jsonb;source jsonb;BEGIN
       IF NOT EXISTS(SELECT 1 FROM public.entity_instances WHERE id=i::uuid AND workspace_id=w AND entity_type_id=(o->>'entityTypeId')::uuid) THEN RETURN NULL;END IF;
       catalog:=public.association_drain_fixture_catalog(w,o,t);source:=public.read_scope_source(w,'entity_instance',i::uuid);
       IF source IS NULL THEN RETURN NULL;END IF;RETURN (catalog-'scope')||jsonb_build_object('recordVersion',source->>'version','source',source);END $$;
      REVOKE ALL ON FUNCTION association_drain_fixture_metadata(uuid,jsonb,text,text) FROM PUBLIC;
      INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required)
       VALUES('association','drain-fixture-v1','{}','association_drain_fixture_metadata(uuid,jsonb,text,text)'::regprocedure,'association_drain_fixture_catalog(uuid,jsonb,text)'::regprocedure,false)`)
  })
  afterAll(async()=>{try{
    await pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=ANY($1::uuid[]) AND module_key='association'",[protectedWorkspaces])
    await pool.query("DELETE FROM application_native_field_contracts WHERE module_key='association'")
    await pool.query('DROP FUNCTION association_drain_fixture_metadata(uuid,jsonb,text,text);DROP FUNCTION association_drain_fixture_catalog(uuid,jsonb,text)')
  }finally{_resetCoalescerForTests();await pool.end();await appPool.end()}})

  it('expires over 100 orders and finishes a requested drain after restart without deleting history',async()=>{
    const f=await fixture();for(let i=0;i<105;i++)await f.order()
    expect((await f.drain()).module.state).toBe('draining')
    await createAssociationLifecycleWorker().tick()
    expect((await modules.get(f.workspaceId, 'association')).state).toBe('disabled')
    expect((await pool.query("SELECT count(*)::int count FROM association_orders WHERE workspace_id=$1 AND status='cancelled'",[f.workspaceId])).rows[0].count).toBe(105)
    expect((await pool.query("SELECT count(*)::int count FROM association_registrations WHERE workspace_id=$1 AND status='cancelled'",[f.workspaceId])).rows[0].count).toBe(105)
    await createAssociationLifecycleWorker().tick()
    expect((await pool.query("SELECT count(*)::int count FROM association_audit_log WHERE workspace_id=$1 AND action='order.expired'",[f.workspaceId])).rows[0].count).toBe(105)
    expect((await pool.query('SELECT count(*)::int count FROM association_provider_events WHERE workspace_id=$1',[f.workspaceId])).rows[0].count).toBe(0)
  })
  it('keeps future and indefinite pending orders as drain blockers, and preserves paid orders',async()=>{
    const f=await fixture(),future=await f.order(false),indefinite=await f.order(false),paid=await f.order(false),expired=await f.order()
    await commerce.confirmFreeOrder(f.workspaceId,paid,f.actor)
    await pool.query('UPDATE association_orders SET reservation_expires_at=NULL WHERE id=$1',[indefinite])
    for(const id of [future,indefinite,paid,randomUUID()])expect((await f.expire(id)).created).toBe(false)
    await f.drain();expect(await finishAssociationDrain(f.workspaceId)).toBe(false)
    expect((await commerce.getOrder(f.workspaceId,paid))?.status).toBe('paid')
    expect((await commerce.getOrder(f.workspaceId,expired))?.status).toBe('pending')
    expect((await f.expire(expired)).created).toBe(true)
    expect(await finishAssociationDrain(f.workspaceId)).toBe(false)
  })
  it('two workers commit one expiry and one drain completion; re-enable cannot be overridden',async()=>{
    const f=await fixture(),id=await f.order();expect((await f.drain()).module.state).toBe('draining')
    expect((await pool.query("SELECT module_key FROM application_native_resource_owners WHERE workspace_id=$1",[f.workspaceId])).rows).toEqual([{module_key:'association'}])
    expect((await Promise.all([f.expire(id),f.expire(id)])).filter(r=>r.created)).toHaveLength(1)
    const beforeFinish=await drainSnapshot(f.workspaceId)
    expect((await Promise.all([finishAssociationDrain(f.workspaceId),finishAssociationDrain(f.workspaceId)])).filter(Boolean)).toHaveLength(1)
    const afterFinish=await drainSnapshot(f.workspaceId)
    expect(afterFinish.module.version).toBe(beforeFinish.module.version+1)
    expect(afterFinish.audit).toHaveLength(beforeFinish.audit.length+1)
    expect(afterFinish.audit.filter((entry:{details:{actorKind?:string}})=>entry.details.actorKind==='system_job')).toMatchObject([{actor_user_id:null,details:{action:'finish_disable',version:beforeFinish.module.version+1}}])
    expect(afterFinish.witnesses).toEqual([])
    const disabled=await modules.get(f.workspaceId, 'association')
    await modules.act(f.workspaceId, f.userId, 'association', {action:'enable',expectedVersion:disabled.version})
    expect(await finishAssociationDrain(f.workspaceId)).toBe(false)
    expect((await modules.get(f.workspaceId, 'association')).state).toBe('enabled')
  })
  it('rechecks stale expiry candidates and refuses expiry authority from a member or unrelated job',async()=>{
    const f=await fixture(),id=await f.order(),other=await fixture()
    await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[id])
    expect((await f.expire(id)).created).toBe(false)
    expect((await other.expire(id)).created).toBe(false)
    await expect(service.execute({...f.context,actor:{kind:'user',userId:f.userId}},{kind:'expire_due_order',orderId:id})).rejects.toMatchObject({code:'not_authorized'})
    await expect(commerce.expireDueOrder(f.workspaceId,id,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(service.execute(f.context,{kind:'cancel_order',orderId:id})).rejects.toMatchObject({code:'not_authorized'})
  })
  it('expiry waits for a concurrent paid transition and preserves its registrations',async()=>{
    const f=await fixture(),id=await f.order(false),writer=await pool.connect()
    let pending:ReturnType<typeof f.expire>|undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE association_orders SET status='paid',reservation_expires_at=NULL WHERE id=$1",[id])
      await writer.query("UPDATE association_registrations SET status='confirmed',reservation_expires_at=NULL WHERE order_id=$1",[id])
      pending=f.expire(id);await blocked('SELECT status,total_minor::text')
      await writer.query('COMMIT');expect((await pending).created).toBe(false)
      expect((await commerce.getOrder(f.workspaceId,id))?.status).toBe('paid')
      expect((await pool.query('SELECT status FROM association_registrations WHERE order_id=$1',[id])).rows[0].status).toBe('confirmed')
    }finally{await writer.query('ROLLBACK').catch(()=>{});writer.release();if(pending)await pending}
  })
  it.each(['enable','finish'] as const)('serializes typed re-enable and automatic finish when %s wins',async winner=>{
    const f=await fixture(),id=await f.order();await f.drain();await f.expire(id)
    const before=await modules.get(f.workspaceId,'association')
    const pause=schedulingPool(winner==='enable'?appPool:pool,sql=>winner==='enable'?sql.startsWith('UPDATE workspace_modules'):sql.includes('SELECT association_finish_module_drain('))
    const typed=createAssociationWorkspaceModulesStore(pool,pause.pool)
    let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined
    try{
      if(winner==='enable'){
        first=typed.act(f.workspaceId,f.userId,'association',{action:'enable',expectedVersion:before.version});void first.catch(()=>{})
        await Promise.race([pause.ready,first.then(()=>{throw Error('Expected staged enable')})])
        second=finishAssociationDrain(f.workspaceId);void second.catch(()=>{})
        await waiter(pause.pid(),'SELECT association_finish_module_drain(')
        pause.release();await first;expect(await second).toBe(false)
      }else{
        first=finishAssociationDrain(f.workspaceId,pause.pool);void first.catch(()=>{})
        await Promise.race([pause.ready,first.then(()=>{throw Error('Expected staged finish')})])
        second=modules.act(f.workspaceId,f.userId,'association',{action:'enable',expectedVersion:before.version});void second.catch(()=>{})
        await waiter(pause.pid(),'module_key=$2 FOR UPDATE')
        pause.release();expect(await first).toBe(true)
        await expect(second).rejects.toMatchObject({code:'stale_module_version'})
        expect(await modules.act(f.workspaceId,f.userId,'association',{action:'enable',expectedVersion:before.version+1})).toMatchObject({module:{state:'enabled'}})
      }
      expect((await modules.get(f.workspaceId,'association')).state).toBe('enabled')
      expect((await drainSnapshot(f.workspaceId)).witnesses).toEqual([])
    }finally{pause.release();await Promise.allSettled([...(first?[first]:[]),...(second?[second]:[])])}
  })
  it('rolls back order and registration state if audit fails, and retries safely',async()=>{
    const f=await fixture(),id=await f.order()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_order_expiry CHECK(action<>'order.expired') NOT VALID")
    try {
      await expect(f.expire(id)).rejects.toThrow()
      expect((await commerce.getOrder(f.workspaceId,id))?.status).toBe('pending')
      expect((await pool.query("SELECT status FROM association_registrations WHERE workspace_id=$1 AND order_id=$2",[f.workspaceId,id])).rows[0].status).toBe('reserved')
    }finally{await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_order_expiry')}
    expect((await f.expire(id)).created).toBe(true)
  })
  it('finishes accepted intent after requester membership is removed with exact state, history and audit continuity',async()=>{
    const f=await fixture(),id=await f.order();await f.drain();await f.expire(id)
    const business=async()=>(await pool.query(`SELECT
      (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY id),'[]') FROM workspace_home_apps h WHERE workspace_id=$1) AS home,
      (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM assistant_capabilities c WHERE assistant_id=$2) AS grants,
      (SELECT to_jsonb(o) FROM association_orders o WHERE id=$3) AS orders,
      (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM association_registrations r WHERE order_id=$3) AS registrations,
      (SELECT to_jsonb(r) FROM entity_instances r WHERE id=$4) AS owned`,[f.workspaceId,f.assistantId,id,f.ownedRow.id])).rows[0]
    const saved=await business()
    // This fixture observes empty Home registry/capability collections; it does
    // not manufacture grants or claim populated Home integration coverage.
    expect(saved.home).toEqual([]);expect(saved.grants).toEqual([])
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    const before=await drainSnapshot(f.workspaceId)
    expect(await finishAssociationDrain(f.workspaceId)).toBe(true)
    const after=await drainSnapshot(f.workspaceId)
    expect(after.module).toMatchObject({...before.module,state:'disabled',version:before.module.version+1,updated_by_user_id:null,disabled_at:expect.any(String),updated_at:expect.any(String)})
    expect(after.module.disabled_at).toBe(after.module.updated_at)
    expect(after.module.disable_requested_at).toBe(before.module.disable_requested_at)
    expect(after.module.enabled_at).toBe(before.module.enabled_at)
    expect(after.epoch).not.toBe(before.epoch);expect(after.witnesses).toEqual([])
    expect(after.audit).toHaveLength(before.audit.length+1)
    expect(after.audit.filter((entry:{details:{actorKind?:string}})=>entry.details.actorKind==='system_job')).toMatchObject([{actor_user_id:null,event_type:'workspace.module_changed',subject_id:f.workspaceId,details:{moduleKey:'association',action:'finish_disable',from:'draining',to:'disabled',version:before.module.version+1,actorKind:'system_job'}}])
    expect(await business()).toEqual(saved)
    expect(await finishAssociationDrain(f.workspaceId)).toBe(false)
    expect(await drainSnapshot(f.workspaceId)).toEqual(after)
  })
  it.each(['settlement','finish'] as const)('rechecks the actual pending blocker when %s holds the module first',async winner=>{
    const f=await fixture(),id=await f.order();await f.drain()
    const pause=schedulingPool(pool,sql=>winner==='settlement'?sql.startsWith('UPDATE association_orders SET status=$3'):sql.includes('SELECT association_finish_module_drain('))
    const settling=createAssociationStore(pause.pool)
    const expiryActor={credentialKind:'system_job' as const,credentialId:`association_expiry:${randomUUID()}`}
    let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined
    try{
      if(winner==='settlement'){
        first=settling.expireDueOrder(f.workspaceId,id,expiryActor);void first.catch(()=>{})
        await Promise.race([pause.ready,first.then(()=>{throw Error('Expected staged settlement')})])
        second=finishAssociationDrain(f.workspaceId);void second.catch(()=>{})
        await waiter(pause.pid(),'SELECT association_finish_module_drain(')
        pause.release();await first;expect(await second).toBe(true)
      }else{
        first=finishAssociationDrain(f.workspaceId,pause.pool);void first.catch(()=>{})
        await Promise.race([pause.ready,first.then(()=>{throw Error('Expected staged blocker check')})])
        second=f.expire(id);void second.catch(()=>{})
        await waiter(pause.pid(),'module_key=$2 FOR SHARE')
        pause.release();expect(await first).toBe(false);await second
        expect(await finishAssociationDrain(f.workspaceId)).toBe(true)
      }
      expect((await commerce.getOrder(f.workspaceId,id))?.status).toBe('cancelled')
      expect((await modules.get(f.workspaceId,'association')).state).toBe('disabled')
    }finally{pause.release();await Promise.allSettled([...(first?[first]:[]),...(second?[second]:[])])}
  })
  it.each(['order','shutdown'] as const)('retains admitted work and refuses fresh commerce when %s wins shutdown ordering',async winner=>{
    const f=await fixture();if(winner==='shutdown')await f.order(false)
    const before=(await modules.get(f.workspaceId,'association')).version
    const pause=schedulingPool(winner==='order'?pool:appPool,sql=>winner==='order'?sql.includes('INSERT INTO association_orders'):sql.startsWith('UPDATE workspace_modules'))
    const stagedCommerce=createAssociationStore(pause.pool),typed=createAssociationWorkspaceModulesStore(pool,pause.pool)
    // Reuse the canonical order path with the same existing event/ticket/contact.
    const original=(await pool.query('SELECT e.id,t.id AS ticket_id FROM association_events e JOIN association_ticket_types t ON t.event_id=e.id WHERE e.workspace_id=$1',[f.workspaceId])).rows[0]
    const contact=(await pool.query("SELECT id FROM entities WHERE workspace_id=$1 AND kind='person'",[f.workspaceId])).rows[0].id
    const input=OrderCreateSchema.parse({contactId:contact,idempotencyKey:randomUUID(),lines:[{ticketId:original.ticket_id,quantity:1,attendees:[{name:'Fictional attendee'}]}]})
    let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined
    try{
      if(winner==='order'){
        first=stagedCommerce.createOrder(f.workspaceId,input,f.actor);void first.catch(()=>{})
        await Promise.race([pause.ready,first.then(()=>{throw Error('Expected staged order')})])
        second=modules.act(f.workspaceId,f.userId,'association',{action:'request_disable',expectedVersion:before});void second.catch(()=>{})
        await waiter(pause.pid(),'module_key=$2 FOR UPDATE')
        pause.release();await first;expect(await second).toMatchObject({module:{state:'draining'},pendingOrders:1})
      }else{
        first=typed.act(f.workspaceId,f.userId,'association',{action:'request_disable',expectedVersion:before});void first.catch(()=>{})
        await Promise.race([pause.ready,first.then(()=>{throw Error('Expected staged shutdown')})])
        second=commerce.createOrder(f.workspaceId,input,f.actor);void second.catch(()=>{})
        await waiter(pause.pid(),'module_key=$2 FOR SHARE')
        pause.release();await first;await expect(second).rejects.toMatchObject({code:'module_draining'})
      }
      expect((await pool.query('SELECT count(*)::int count FROM association_orders WHERE workspace_id=$1',[f.workspaceId])).rows[0].count).toBe(1)
      await expect(f.order(false)).rejects.toMatchObject({code:'module_draining'})
    }finally{pause.release();await Promise.allSettled([...(first?[first]:[]),...(second?[second]:[])])}
  })
  it.each(['audit','finalizer'] as const)('rolls module, epoch, audit and witness back on %s failure then retries once',async kind=>{
    const f=await fixture(),id=await f.order();await f.drain();await f.expire(id)
    const before=await drainSnapshot(f.workspaceId)
    if(kind==='audit')await pool.query(`ALTER TABLE workspace_audit_log ADD CONSTRAINT association_drain_fixture_refuse CHECK(workspace_id<>'${f.workspaceId}'::uuid OR details->>'actorKind' IS DISTINCT FROM 'system_job') NOT VALID`)
    else await pool.query(`CREATE FUNCTION association_drain_fixture_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional finalizer refusal';END $$;
      CREATE TRIGGER association_drain_fixture_refuse BEFORE DELETE ON application_native_module_lifecycle_reviews FOR EACH ROW WHEN (OLD.workspace_id='${f.workspaceId}'::uuid) EXECUTE FUNCTION association_drain_fixture_refuse()`)
    try{await expect(finishAssociationDrain(f.workspaceId)).rejects.toThrow();expect(await drainSnapshot(f.workspaceId)).toEqual(before)}
    finally{if(kind==='audit')await pool.query('ALTER TABLE workspace_audit_log DROP CONSTRAINT association_drain_fixture_refuse');else await pool.query('DROP TRIGGER association_drain_fixture_refuse ON application_native_module_lifecycle_reviews;DROP FUNCTION association_drain_fixture_refuse()')}
    expect(await finishAssociationDrain(f.workspaceId)).toBe(true)
    expect((await drainSnapshot(f.workspaceId)).audit).toHaveLength(before.audit.length+1)
    expect(await finishAssociationDrain(f.workspaceId)).toBe(false)
  })
  it('denies private runtime access, forged context and raw owner writes; consumed continuation cannot authorize another write',async()=>{
    const f=await fixture(),id=await f.order();await f.drain();await f.expire(id)
    for(const sql of ['SELECT association_finish_module_drain($1)','SELECT * FROM application_native_module_lifecycle_reviews WHERE workspace_id=$1',"INSERT INTO application_native_module_lifecycle_reviews(transaction_id,backend_pid,workspace_id,module_key,observed_version,action,default_state,authority_revision,continuation_before) VALUES(txid_current(),pg_backend_pid(),$1,'association',3,'finish_disable','draining','forged','{}')"]){
      const client=await appPool.connect();try{await client.query('BEGIN');await applyRLSGucs(client,f.userId);await expect(client.query(sql,[f.workspaceId])).rejects.toMatchObject({code:'42501'})}finally{await client.query('ROLLBACK');client.release()}
    }
    for(const source of [pool,appPool]){
      const client=await source.connect();try{await client.query('BEGIN');await applyRLSGucs(client,f.userId);await client.query("SELECT set_config('app.actor_kind','system_job',true),set_config('app.module_drain','true',true)");await expect(client.query("UPDATE workspace_modules SET state='disabled',version=version+1 WHERE workspace_id=$1 AND module_key='association'",[f.workspaceId])).rejects.toMatchObject({code:'42501'})}finally{await client.query('ROLLBACK');client.release()}
    }
    const before=await drainSnapshot(f.workspaceId),client=await pool.connect()
    try{await client.query('BEGIN');expect((await client.query('SELECT association_finish_module_drain($1) AS finished',[f.workspaceId])).rows[0].finished).toBe(true)
      expect((await client.query('SELECT * FROM application_native_module_lifecycle_reviews WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
      await expect(client.query("UPDATE workspace_modules SET state='enabled',version=version+1 WHERE workspace_id=$1 AND module_key='association'",[f.workspaceId])).rejects.toMatchObject({code:'42501'})
    }finally{await client.query('ROLLBACK');client.release()}
    expect(await drainSnapshot(f.workspaceId)).toEqual(before);expect(await finishAssociationDrain(f.workspaceId)).toBe(true)
  })
  it.each(['version','action','key','extra','digest','used','backend'] as const)('refuses a faulted %s continuation and rolls back its whole transaction',async fault=>{
    const f=await fixture(),id=await f.order();await f.drain();await f.expire(id)
    const before=await drainSnapshot(f.workspaceId)
    const edits={version:'NEW.observed_version:=NEW.observed_version+1;',action:"NEW.action:='enable';",key:"NEW.module_key:='foreign_module';",extra:"NEW.continuation_before:=NEW.continuation_before||jsonb_build_object('extra',true);",digest:"NEW.authority_revision:='forged';",used:'NEW.used:=true;',backend:'NEW.backend_pid:=NEW.backend_pid+1;'}
    await pool.query(`CREATE FUNCTION association_drain_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${edits[fault]} RETURN NEW;END $$;
      CREATE TRIGGER association_drain_fixture_fault BEFORE INSERT ON application_native_module_lifecycle_reviews FOR EACH ROW WHEN (NEW.workspace_id='${f.workspaceId}'::uuid AND NEW.continuation_before IS NOT NULL) EXECUTE FUNCTION association_drain_fixture_fault()`)
    try{await expect(finishAssociationDrain(f.workspaceId)).rejects.toMatchObject({code:fault==='action'?'23514':'42501'});expect(await drainSnapshot(f.workspaceId)).toEqual(before)}
    finally{await pool.query('DROP TRIGGER association_drain_fixture_fault ON application_native_module_lifecycle_reviews;DROP FUNCTION association_drain_fixture_fault()')}
    expect(await finishAssociationDrain(f.workspaceId)).toBe(true)
  })
})
