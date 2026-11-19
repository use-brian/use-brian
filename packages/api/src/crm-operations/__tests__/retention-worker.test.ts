import {describe,it,expect,vi} from 'vitest'
import {CrmOperationsCommandSchema} from '@use-brian/core/crm/operations-types.js'
import {CrmRetentionPolicySchema} from '@use-brian/core/crm/retention-types.js'
import {createCrmRetentionWorker} from '../retention-worker.js'

const policy={scheduled:false,intervalSeconds:60,resolvedSubmissionsSeconds:null,openSubmissions:null,
  importReceiptsSeconds:null,deliveryReceiptsSeconds:null,auditSeconds:null,financialRecordsSeconds:null,holds:[]}
describe('[COMP:crm/retention] Retention worker and policy contract',()=>{
  it('requires explicit scheduling and valid positive ages and distinct selected fields',()=>{
    expect(CrmRetentionPolicySchema.parse(policy).scheduled).toBe(false)
    expect(CrmRetentionPolicySchema.safeParse({...policy,scheduled:undefined}).success).toBe(false)
    expect(CrmRetentionPolicySchema.safeParse({...policy,resolvedSubmissionsSeconds:0}).success).toBe(false)
    expect(CrmRetentionPolicySchema.safeParse({...policy,openSubmissions:{afterSeconds:60,fields:['message','message']}}).success).toBe(false)
    expect(CrmOperationsCommandSchema.safeParse({kind:'execute_retention',previewId:'00000000-0000-4000-8000-000000000001',previewHash:'a'.repeat(64),confirmed:false}).success).toBe(false)
  })
  it('honors a kill switch before scanning or running a workspace',async()=>{
    const list=vi.fn(async()=>['one']),run=vi.fn(async()=> 'completed' as const)
    const worker=createCrmRetentionWorker({enabled:()=>false,list,run})
    expect(await worker.tick()).toBe(0);expect(list).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled()
  })
  it('serializes concurrent ticks and continues beyond the first workspace page',async()=>{
    const ids=Array.from({length:60},(_,i)=>String(i).padStart(3,'0'))
    const list=vi.fn(async(after:string|null,limit:number)=>ids.filter(id=>after===null||id>after).slice(0,limit))
    const run=vi.fn(async()=> 'completed' as const),worker=createCrmRetentionWorker({list,run,enabled:()=>true})
    const a=worker.tick(),b=worker.tick();expect(a).toBe(b)
    await Promise.all([a,b]);await worker.tick();await worker.tick()
    expect(run.mock.calls).toHaveLength(60)
    expect(list.mock.calls.map(([after])=>after)).toEqual([null,'024','049'])
  })
  it('continues after a failed workspace without passing sensitive provider errors to logging',async()=>{
    const onError=vi.fn(),run=vi.fn(async(id:string)=>{if(id==='one')throw Error('private payload');return 'completed' as const})
    await createCrmRetentionWorker({enabled:()=>true,list:async()=>['one','two'],run,onError}).tick()
    expect(run).toHaveBeenCalledTimes(2);expect(onError).toHaveBeenCalledExactlyOnceWith()
  })
})
