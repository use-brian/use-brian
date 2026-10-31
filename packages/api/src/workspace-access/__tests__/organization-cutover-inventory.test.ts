import type {PoolClient} from 'pg'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {MIGRATION_INVENTORY_FAMILIES,organizationCutoverInventory} from '../migration-inventory.js'

vi.mock('../command-review.js',()=>({withCommandReviewTransaction:vi.fn()}))
afterEach(()=>vi.restoreAllMocks())

describe('[COMP:api/organization-cutover] inventory time budget',()=>{
 it.each(['first','last'] as const)('refuses a %s-family fetch which returns after the deadline',async(position)=>{
  let now=0,family=-1
  vi.spyOn(performance,'now').mockImplementation(()=>now)
  const target=position==='first'?0:MIGRATION_INVENTORY_FAMILIES.length-1
  const query=vi.fn(async(sql:string)=>{
   if(sql.startsWith('DECLARE'))family++
   if(sql.startsWith('FETCH')&&family===target)now=10_001
   return {rows:[]}
  })
  await expect(organizationCutoverInventory({query} as unknown as PoolClient,'workspace')).rejects.toMatchObject({code:'cutover_busy'})
  expect(family).toBe(target)
 })
 it('shares one deadline across batches instead of renewing the budget on every fetch',async()=>{
  let now=0,fetches=0
  vi.spyOn(performance,'now').mockImplementation(()=>now)
  const query=vi.fn(async(sql:string)=>{
   if(sql.startsWith('FETCH')) {
    now+=6_000
    fetches++
    return {rows:Array.from({length:500},(_,i)=>({record:`${i}:1:{}`}))}
   }
   return {rows:[]}
  })
  await expect(organizationCutoverInventory({query} as unknown as PoolClient,'workspace')).rejects.toMatchObject({code:'cutover_busy'})
  expect(fetches).toBe(2)
 })
})
