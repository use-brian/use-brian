/** Typed CRM adapters retain actor, full-DTO admission and the canonical writer. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccessContext } from '@use-brian/core'

const transactionClient=vi.hoisted(() => ({query:vi.fn(),release:vi.fn()}))
const canonical=vi.hoisted(() => ({point:vi.fn(),actors:new WeakMap<object,string>()}))
vi.mock('../client.js', () => ({
  query:vi.fn(),queryGated:vi.fn(),queryWithRLS:vi.fn(),
  getAppPool:vi.fn(() => ({connect:async () => transactionClient})),
  applyRLSGucs:vi.fn(),rollbackAndRelease:vi.fn(),
}))
vi.mock('../entities-store.js', () => ({
  assertNativeEntityFieldWrites:vi.fn(),createEntity:vi.fn(),getEntityById:vi.fn(),getEntityByIdSystem:vi.fn(),updateEntity:vi.fn(),
}))
vi.mock('../crm-reader.js',async importOriginal => ({
  ...await importOriginal<typeof import('../crm-reader.js')>(),readLegacyCanonicalCrmPoint:canonical.point,
}))
// These transport fixtures use the native numeric amount format. Its real
// private capture/decimal validation is exercised by the PostgreSQL suites.
vi.mock('../../application-platform/field-evidence.js',async importOriginal => ({
  ...await importOriginal<typeof import('../../application-platform/field-evidence.js')>(),
  canonicalNativeAmountEncoding:(projection:{values:{amount:string|null}})=>projection.values.amount===null?'null':'number',
}))
import { updateContact,updateCompany,setDealStage } from '../crm.js'
import { applyRLSGucs } from '../client.js'
import { getEntityById,getEntityByIdSystem,updateEntity } from '../entities-store.js'

const USER='00000000-0000-4000-8000-000000000001'
const WORKSPACE='00000000-0000-4000-8000-000000000002'
const ID='00000000-0000-4000-8000-000000000003'
const CTX:AccessContext={workspaceId:WORKSPACE,userId:USER,assistantId:'00000000-0000-4000-8000-000000000004',assistantKind:'standard'}
let row:{workspaceId:string;name:string;stage:string;amount:number;version:number}
let stateResults:Array<null>|undefined
function scope(){return {workspaceId:row.workspaceId,userId:null,assistantId:null,sensitivity:'internal' as const,compartments:[],projectIds:[]}}
function sqlResult(client:object,sql:string,params?:unknown[]) {
  if(sql.includes("current_setting('app.current_user_id'"))return {rows:[{actor:canonical.actors.get(client)}],rowCount:1}
  if(sql.includes('application_crm_patch_state'))return {rows:[{value:stateResults?.length?stateResults.shift():{workspaceId:row.workspaceId,id:params?.[1],version:String(row.version),scope:scope()}}],rowCount:1}
  if(sql.includes(' AS admitted FROM jsonb_to_recordset'))return {rows:[{admitted:true}],rowCount:1}
  if(sql.includes('application_patch_canonical_crm')){
    const fields=params?.[2] as {name?:string;stage?:string}
    if(fields.name!==undefined)row.name=fields.name
    if(fields.stage!==undefined)row.stage=fields.stage
    row.version++
    return {rows:[{value:{workspaceId:row.workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:params?.[0],id:params?.[1],version:String(row.version)}}],rowCount:1}
  }
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[],rowCount:0}
  throw new Error(`Unexpected CRM transport SQL: ${sql}`)
}
const patchCalls=(client=transactionClient)=>client.query.mock.calls.filter(call=>String(call[0]).includes('application_patch_canonical_crm'))

beforeEach(()=>{
  vi.resetAllMocks()
  row={workspaceId:WORKSPACE,name:'Someone',stage:'lead',amount:50000,version:1}
  stateResults=undefined
  canonical.actors.delete(transactionClient)
  vi.mocked(applyRLSGucs).mockImplementation(async(client,user)=>{canonical.actors.set(client,user)})
  transactionClient.query.mockImplementation(async(sql:string,params?:unknown[])=>sqlResult(transactionClient,sql,params))
  canonical.point.mockImplementation(async(_access:AccessContext,type:string,id:string,fields:readonly string[])=>{
    const values={name:row.name,email:null,phone:null,companyId:null,contactId:null,stage:row.stage,amount:String(row.amount),closeDate:null,
      aliases:[],tags:[],externalRef:{},createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}
    return {projection:{ref:{workspaceId:row.workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:type,id,version:String(row.version)},
      values:Object.fromEntries(fields.map(key=>[key,values[key as keyof typeof values]])),fields:[...fields],policyVersion:'a'.repeat(64)},
      scope:scope(),sources:[]}
  })
})

describe('[COMP:crm/update] CRM source authority threading',()=>{
  it('uses canonical full-DTO admission before a contact patch',async()=>{
    expect((await updateContact(USER,ID,{name:'New'},undefined,CTX))?.name).toBe('New')
    expect(applyRLSGucs).toHaveBeenCalledWith(transactionClient,USER)
    expect(transactionClient.query).toHaveBeenCalledWith('COMMIT')
    expect(transactionClient.query).toHaveBeenCalledWith('SELECT application_crm_patch_state($1,$2,$3) AS value',['person',ID,['name']])
    expect(canonical.point).toHaveBeenCalledTimes(2)
    expect(canonical.point.mock.calls.every(call=>call[0]===CTX&&call[1]==='person'&&call[2]===ID&&call[4]===transactionClient)).toBe(true)
    const patchIndex=transactionClient.query.mock.calls.findIndex(call=>String(call[0]).includes('application_patch_canonical_crm'))
    expect(canonical.point.mock.invocationCallOrder[0]).toBeLessThan(transactionClient.query.mock.invocationCallOrder[patchIndex]!)
    expect(patchCalls()).toHaveLength(1)
    expect(updateEntity).not.toHaveBeenCalled()
    expect(getEntityById).not.toHaveBeenCalled()
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
  })
  it('keeps the authenticated actor on a context-free source read',async()=>{
    row.workspaceId='00000000-0000-4000-8000-000000000005'
    await updateContact(USER,ID,{name:'New'})
    expect(applyRLSGucs).toHaveBeenCalledWith(transactionClient,USER)
    expect(canonical.point.mock.calls.every(call=>call[0].userId===USER&&call[0].workspaceId===row.workspaceId&&call[4]===transactionClient)).toBe(true)
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
    expect(patchCalls()).toHaveLength(1)
  })
  it('does not submit a patch after an inaccessible source gate',async()=>{
    stateResults=[null]
    expect(await updateContact(USER,ID,{name:'X'},undefined,CTX)).toBeNull()
    expect(canonical.point).not.toHaveBeenCalled()
    expect(patchCalls()).toHaveLength(0)
    expect(updateEntity).not.toHaveBeenCalled()
  })
  it('propagates a mutation refusal after an authorized source read',async()=>{
    const original=transactionClient.query.getMockImplementation()!
    let states=0
    transactionClient.query.mockImplementation(async(sql:string,params?:unknown[])=>{
      if(sql.includes('application_crm_patch_state')&&++states===2)return {rows:[{value:null}],rowCount:1}
      return original(sql,params)
    })
    expect(await updateContact(USER,ID,{name:'X'},undefined,CTX)).toBeNull()
    expect(canonical.point).toHaveBeenCalledOnce()
    expect(canonical.point.mock.calls[0]![0]).toBe(CTX)
    expect(patchCalls()).toHaveLength(0)
  })
  it('refuses an absent company transaction actor without raw mutation fallback',async()=>{
    vi.mocked(applyRLSGucs).mockResolvedValue(undefined)
    await expect(updateCompany(USER,ID,{name:'X'},CTX)).rejects.toMatchObject({code:'access_unavailable'})
    expect(updateEntity).not.toHaveBeenCalled()
    expect(getEntityById).not.toHaveBeenCalled()
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
    expect(transactionClient.query).toHaveBeenCalledWith('ROLLBACK')
    expect(transactionClient.query).not.toHaveBeenCalledWith('COMMIT')
  })
  it('threads explicit access through both stage operations',async()=>{
    expect((await setDealStage(USER,ID,'won',CTX))?.stage).toBe('won')
    expect(canonical.point.mock.calls.map(call=>call[0])).toEqual([CTX,CTX])
    expect(canonical.point.mock.calls.map(call=>call[4])).toEqual([transactionClient,transactionClient])
    expect(patchCalls()[0]?.[1]).toEqual(['deal',ID,{stage:'won'},'1',null])
  })
  it('uses the shared correction client for the source read and write',async()=>{
    const client={query:vi.fn(async(sql:string,params?:unknown[])=>sqlResult(client,sql,params))}
    canonical.actors.set(client,USER)
    const result=await setDealStage(USER,ID,'won',CTX,client as never)
    expect(canonical.point.mock.calls.map(call=>call[4])).toEqual([client,client])
    expect(client.query.mock.calls.find(call=>String(call[0]).includes('application_patch_canonical_crm'))?.[1]).toEqual(['deal',ID,{stage:'won'},'1',null])
    expect(result).toMatchObject({stage:'won',amount:50000})
    expect(client.query).not.toHaveBeenCalledWith('COMMIT')
    expect(updateEntity).not.toHaveBeenCalled()
  })
})
