import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,type AccessContext} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore,type KnowledgeEntry} from '../../db/knowledge-store.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
type Reader={name:string;read:(ctx:AccessContext,row:KnowledgeEntry)=>Promise<boolean>}
const readers:Reader[]=[
 {name:'point ID',read:async(ctx,row)=>!!await store.getById(ctx,row.id)},
 {name:'point path',read:async(ctx,row)=>!!await store.getByPath(ctx,row.path)},
 {name:'top-level path',read:async(ctx,row)=>(await store.listByPath(ctx,'')).some(value=>value.id===row.id)},
 {name:'path index',read:async(ctx,row)=>(await store.listByPath(ctx,row.path)).some(value=>value.id===row.id)},
 {name:'full-text search',read:async(ctx,row)=>(await store.search(ctx,'fixture',1)).some(value=>value.id===row.id)},
 {name:'summary catalog',read:async(ctx,row)=>(await store.listSummaries(ctx)).some(value=>value.id===row.id)},
 {name:'brain recent list',read:async(ctx,row)=>(await store.listForBrain(ctx,'',1)).some(value=>value.id===row.id)},
 {name:'brain ranked list',read:async(ctx,row)=>(await store.listForBrain(ctx,'fixture',1)).some(value=>value.id===row.id)},
 {name:'graph',read:async(ctx,row)=>(await store.listForGraph(ctx,1)).some(value=>value.id===row.id)},
 {name:'related refs',read:async(ctx,row)=>(await store.listByIds(ctx,[row.id])).some(value=>value.id===row.id)},
 {name:'path catalog',read:async(ctx,row)=>(await store.listPaths(ctx)).includes(row.path)},
 {name:'existence',read:ctx=>store.hasEntries(ctx)},
]
describe.sequential('[COMP:api/application-persistence] actual native knowledge viewers',()=>{
 let f:Fixture|undefined
 afterEach(async()=>{await f?.cleanup();f=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function fixture(){
  f=await persistentContextFixture();const current=f
  const row=await store.create({workspaceId:current.workspaceId,path:'fictional',title:'Fictional fixture knowledge',
   content:'Fictional fixture reader payload',sensitivity:'internal',createdBy:current.ownerId})
  const first=(await current.execution(current.firstId)).security.access
  const second=(await current.execution(current.secondId)).security.access
  return{f:current,row,first,second}
 }
 for(const reader of readers){
  it(`refuses a copied application marker at the actual ${reader.name} native boundary`,async()=>{
   const c=await fixture()
   await expect(reader.read({...c.first,applicationBound:true},c.row)).rejects.toMatchObject({code:'access_unavailable'})
  })
  it(`holds a native held row at the actual ${reader.name} boundary`,async()=>{
   const c=await fixture();expect(await reader.read(c.first,c.row)).toBe(true)
   await c.f.pool.query('UPDATE knowledge_entries SET scope_held=true WHERE id=$1',[c.row.id])
   expect(await reader.read(c.first,c.row)).toBe(false)
  })
  it(`rechecks current membership at the actual ${reader.name} boundary and preserves the same record for another member`,async()=>{
   const c=await fixture();expect(await reader.read(c.first,c.row)).toBe(true)
   const before=(await c.f.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[c.f.workspaceId,c.row.id])).rows[0].source
   await c.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[c.f.workspaceId,c.f.firstId])
   expect(await reader.read(c.first,c.row)).toBe(false)
   expect(await reader.read(c.second,c.row)).toBe(true)
   expect((await c.f.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[c.f.workspaceId,c.row.id])).rows[0].source).toEqual(before)
  })
 }
 it('filters actual child counts and graph/entry relation IDs through the same current native admission',async()=>{
  const c=await fixture(),child=await store.create({workspaceId:c.f.workspaceId,path:'fictional/child',title:'Fictional child fixture',
   content:'Fictional child body',sensitivity:'internal',createdBy:c.f.ownerId})
  await c.f.pool.query('UPDATE knowledge_entries SET related_ids=ARRAY[$2::uuid] WHERE id=$1',[c.row.id,child.id])
  expect((await store.listByPath(c.first,''))[0]).toMatchObject({id:c.row.id,childCount:1})
  expect(await store.getById(c.first,c.row.id)).toMatchObject({relatedIds:[child.id]})
  await c.f.pool.query('UPDATE knowledge_entries SET scope_held=true WHERE id=$1',[child.id])
  expect((await store.listByPath(c.first,''))[0]).toMatchObject({id:c.row.id,childCount:0})
  expect(await store.getById(c.first,c.row.id)).toMatchObject({relatedIds:[]})
  expect((await store.listForGraph(c.first,10)).find(row=>row.id===c.row.id)).toMatchObject({relatedIds:[]})
 })
 it('returns canonical source bindings before actual knowledge tool/model projection can format the row',async()=>{
  const c=await fixture(),row=await store.getById(c.first,c.row.id)
  expect(row).not.toBeNull()
  const canonical=(await c.f.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[c.f.workspaceId,c.row.id])).rows[0].source
  const sources=boundScopeSources(row!)
  expect(sources.filter(source=>source.resourceKind==='knowledge_entry')).toEqual([expect.objectContaining({workspaceId:c.f.workspaceId,resourceKind:'knowledge_entry',resourceId:c.row.id,
   version:canonical.version,userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]})])
  const fields=sources.filter(source=>source.resourceKind==='application_field');expect(fields).toHaveLength(1);expect(sources).toHaveLength(2)
  expect((await c.f.pool.query(`SELECT resource_id,selection FROM application_field_resources WHERE workspace_id=$1 AND id=$2`,[c.f.workspaceId,fields[0].resourceId])).rows)
   .toEqual([{resource_id:c.row.id,selection:'read'}])
 })
})
