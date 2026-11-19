import {describe,it,expect,vi} from 'vitest'
import {CrmOperationsCommandSchema, assertCrmOperationsAuthority, type CrmOperationsContext} from '@use-brian/core/crm/operations-types.js'
import {createCrmEntitlementWorker} from '../entitlement-worker.js'

const id='00000000-0000-4000-8000-000000000001'
describe('[COMP:crm/entitlement-lifecycle] Bounded due-grant worker',()=>{
  it('honors the kill switch and serializes concurrent ticks',async()=>{
    const list=vi.fn(async()=>[]),expire=vi.fn(async()=>{})
    const worker=createCrmEntitlementWorker({enabled:()=>false,list,expire})
    const a=worker.tick(),b=worker.tick();expect(a).toBe(b);expect(await a).toBe(0)
    expect(list).not.toHaveBeenCalled();expect(expire).not.toHaveBeenCalled()
  })
  it('continues beyond 100 and bounds each tick to 1000 candidates',async()=>{
    const rows=Array.from({length:1205},(_,i)=>({id:String(i).padStart(5,'0'),workspaceId:'fixture'}))
    const expire=vi.fn(async(_workspaceId:string,_id:string)=>{}),list=vi.fn(async(after:string|null,limit:number)=>rows.filter(r=>after===null||r.id>after).slice(0,limit))
    const worker=createCrmEntitlementWorker({list,expire,enabled:()=>true})
    expect(await worker.tick()).toBe(1000);expect(await worker.tick()).toBe(205)
    expect(expire).toHaveBeenCalledTimes(1205);expect(new Set(expire.mock.calls.map(c=>c[1])).size).toBe(1205)
  })
  it('retries failed candidates on a later scan without logging their content',async()=>{
    const onError=vi.fn(),expire=vi.fn(async()=>{throw Error('private payload')})
    const worker=createCrmEntitlementWorker({list:async()=>[{id,workspaceId:id}],expire,onError,enabled:()=>true})
    await worker.tick();await worker.tick()
    expect(expire).toHaveBeenCalledTimes(2);expect(onError.mock.calls).toEqual([[],[]])
  })
  it('reserves due expiry for its system principal and rejects arbitrary lifecycle edits from it',()=>{
    const context:CrmOperationsContext={workspaceId:id,actor:{kind:'system_job',job:'entitlement_expiry',runId:id},authority:{role:'owner',canConfigure:false,canWrite:true,trustedIdentitySources:[]}}
    const command=CrmOperationsCommandSchema.parse({kind:'expire_due_entitlement',entitlementId:id})
    expect(()=>assertCrmOperationsAuthority(context,command)).not.toThrow()
    expect(()=>assertCrmOperationsAuthority({...context,actor:{kind:'user',userId:id}},command)).toThrow()
    expect(()=>assertCrmOperationsAuthority(context,CrmOperationsCommandSchema.parse({kind:'update_entitlement',entitlementId:id,status:'expired',endsAt:'2099-01-01T00:00:00Z'}))).toThrow()
    expect(CrmOperationsCommandSchema.safeParse({kind:'expire_due_entitlement',entitlementId:id,endsAt:null}).success).toBe(false)
  })
})
