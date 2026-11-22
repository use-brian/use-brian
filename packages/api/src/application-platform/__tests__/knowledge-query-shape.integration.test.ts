import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import type {AccessContext} from '@use-brian/agent-runtime/security/access-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
// Trace and forward every real query unchanged. This never supplies rows or an
// admission result; the actual non-owner database remains the sole authority.
const calls:{sql:string;values:unknown[]}[]=[]
function trace(client:PoolClient){
 const query=client.query
 client.query=function(...args:unknown[]){
  if(typeof args[0]==='string'&&args[0].includes('WITH knowledge_viewer_rows')&&args[0].includes('jsonb_to_recordset')){
   calls.push({sql:args[0],values:structuredClone(args[1] as unknown[]??[])})
  }
  return Reflect.apply(query,client,args)
 } as typeof client.query
}
describe.sequential('[COMP:api/knowledge-store] real native query construction and behavior',()=>{
 let f:Fixture,ctx:AccessContext
 beforeAll(()=>{getAppPool().on('connect',trace)})
 beforeEach(async()=>{f=await persistentContextFixture('confidential');ctx=(await f.execution()).security.access;calls.length=0})
 afterEach(async()=>{await f?.cleanup()})
 afterAll(async()=>{getAppPool().off('connect',trace);await getAppPool().end();await getPool().end()})
 const current=()=>calls.at(-1)!
 const values=()=>current().values.slice(0,-1)
 const expectValues=(...base:unknown[])=>expect(values()).toEqual([...base,ctx.compartments,ctx.projectIds])
 const seed=(path:string,title='Fictional Knowledge',extra:Partial<Parameters<typeof store.create>[0]>={})=>store.create({workspaceId:f.workspaceId,path,title,
  content:'Fictional ordinary Knowledge',sensitivity:'internal',createdBy:f.ownerId,...extra})
 const standard=()=>({...ctx,assistantKind:'standard' as const})
 it('uses FTS with plainto_tsquery and ranks by ts_rank_cd, scoped by workspace',async()=>{
  const row=await seed('products/vault','Fictional Vault',{content:'Fictional vault fees',summary:'Vault product'})
  const result=await store.search(standard(),'vault fees')
  expect(result.map(r=>r.id)).toEqual([row.id])
  expect(current().sql).toContain('plainto_tsquery');expect(current().sql).toContain('ts_rank_cd');expect(current().sql).toContain('ke.workspace_id = $1')
  expect(current().sql).toContain('assistant_disabled_knowledge_sources');expect(current().sql).toContain('adks.assistant_id = $5')
  expectValues(f.workspaceId,'vault fees',10,'confidential',f.assistantId)
  expect(JSON.parse(current().values.at(-1) as string).map((r:{id:string})=>r.id)).toEqual([row.id])
 })
 it('lists top-level entries when pathPrefix is empty',async()=>{
  const row=await seed('index');await seed('index/child')
  const result=await store.listByPath(standard(),'')
  expect(result.map(r=>r.id)).toEqual([row.id]);expect(result[0]).toMatchObject({childCount:1})
  expect(current().sql).toContain("NOT LIKE '%/%'");expect(current().sql).toContain('ke.workspace_id = $1')
 })
 it('lists direct children and index entry for a nested path',async()=>{
  const index=await seed('products/vault'),child=await seed('products/vault/fees');await seed('products/vault/fees/deep')
  const result=await store.listByPath(standard(),'products/vault')
  expect(result.map(r=>r.id)).toEqual([index.id,child.id]);expect(result[1]).toMatchObject({childCount:1})
 })
 it('browses and searches duplicate paths within the selected source and viewer access',async()=>{
  const source=await store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'fictional/handbook'})
  const manual=await seed('handbook'),synced=await seed('handbook','Fictional Handbook',{sourceId:source.id})
  const child=await seed('handbook/guidelines','Fictional Guidelines',{sourceId:source.id})
  const scoped=standard()
  const root=await store.listByPath(scoped,'')
  expect(root).toEqual(expect.arrayContaining([
   expect.objectContaining({id:manual.id,sourceId:null,childCount:0}),
   expect.objectContaining({id:synced.id,sourceId:source.id,childCount:1}),
  ]))
  expect((await store.listByPath(scoped,'handbook',undefined,source.id)).map(r=>r.id)).toEqual([synced.id,child.id])
  expect((await store.listByPath(scoped,'handbook',undefined,null)).map(r=>r.id)).toEqual([manual.id])
  expect((await store.search(scoped,'Fictional',10,undefined,source.id)).map(r=>r.id).sort()).toEqual([synced.id,child.id].sort())
  await store.setSourceDisabled({assistantId:f.assistantId,sourceId:source.id,disabled:true,userId:f.ownerId})
  expect(await store.listByPath(scoped,'handbook',undefined,source.id)).toEqual([])
  expect(await store.search(scoped,'Fictional',10,undefined,source.id)).toEqual([])
 })
 it('keeps index-less foreign children reachable through a unique visible index',async()=>{
  const indexSource=await store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'fictional/index-source'})
  const childSource=await store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'fictional/child-source'})
  const index=await seed('guide','Fictional Guide',{sourceId:indexSource.id})
  const child=await seed('guide/install','Fictional Install',{sourceId:childSource.id})
  const viewer={...standard(),clearance:'internal' as const}
  expect((await store.listByPath(viewer,'guide')).map(row=>row.id)).toEqual([index.id,child.id])
  expect((await store.listByPath(viewer,'guide',undefined,indexSource.id)).map(row=>row.id)).toEqual([index.id])

  const hidden=await seed('guide','Fictional Hidden Index',{sourceId:childSource.id,sensitivity:'confidential'})
  const root=await store.listByPath(viewer,'')
  expect(root).toMatchObject([{id:index.id,childCount:1}])
  const evidence=boundScopeSources(root[0]).filter(source=>source.resourceKind==='knowledge_entry').map(source=>source.resourceId)
  expect(evidence).toContain(child.id)
  expect(evidence).not.toContain(hidden.id)
 })
 it('returns id, path, summary and sensitivity scoped by workspace and clearance',async()=>{
  const a=await seed('a','Fictional A',{summary:'Summary A'}),b=await seed('b','Fictional B',{sensitivity:'public'})
  const summaries=await store.listSummaries(ctx)
  expect(summaries).toHaveLength(2);expect(summaries.map(r=>r.id)).toEqual([a.id,b.id]);expect(summaries[1].summary).toBeNull()
  expect(current().sql).toContain('workspace_id = $1');expect(current().sql).toContain('sensitivity_rank')
  expectValues(f.workspaceId,'confidential')
 })
 it('returns recent rows ordered by updated_at and id when query is empty',async()=>{
  await seed('a.md','Fictional A');await seed('b.md','Fictional B')
  const rows=await store.listForBrain(ctx,'',50)
  expect(rows).toHaveLength(2);expect(current().sql).toContain('workspace_id = $1')
  expect(current().sql).toContain('ORDER BY updated_at DESC, id');expect(current().sql).not.toContain('plainto_tsquery')
  expectValues(f.workspaceId,'confidential',50,0)
 })
 it("offsets by the caller's cursor position",async()=>{
  await seed('a');await seed('b');const all=await store.listForBrain(ctx,'',50),rows=await store.listForBrain(ctx,'',1,1)
  expect(rows.map(r=>r.id)).toEqual([all[1].id]);expect(current().sql).toContain('OFFSET')
  expectValues(f.workspaceId,'confidential',1,1)
 })
 it('floors a negative or fractional offset to zero-or-whole rows',async()=>{
  await seed('a');await seed('b');const all=await store.listForBrain(ctx,'',50,-5)
  expect(all).toHaveLength(2);expectValues(f.workspaceId,'confidential',50,0)
  const rest=await store.listForBrain(ctx,'',50,1.7)
  expect(rest.map(r=>r.id)).toEqual([all[1].id]);expectValues(f.workspaceId,'confidential',50,1)
 })
 it('runs FTS ranked by ts_rank_cd and id when query is non-empty',async()=>{
  const row=await seed('platform/pricing.md','Fictional Pricing',{content:'Fictional pricing model'})
  expect((await store.listForBrain(ctx,'pricing model',20)).map(r=>r.id)).toEqual([row.id])
  expect(current().sql).toContain('plainto_tsquery');expect(current().sql).toContain('ts_rank_cd');expect(current().sql).toContain('DESC, id')
  expectValues(f.workspaceId,'pricing model','confidential',20,0)
 })
 it('returns ranked graph rows with actual clearance-scoped related IDs',async()=>{
  const a=await seed('features/a','Fictional A',{sensitivity:'public'}),b=await seed('features/b','Fictional B',{sensitivity:'public'}),hidden=await seed('features/hidden','Fictional hidden',{sensitivity:'confidential'})
  await f.pool.query('UPDATE knowledge_entries SET related_ids=$2::uuid[] WHERE id=$1',[a.id,[b.id,hidden.id]])
  const rows=await store.listForGraph({...ctx,clearance:'public'},500)
  expect(rows).toHaveLength(2);expect(rows.find(r=>r.id===a.id)?.relatedIds).toEqual([b.id])
  expect(current().sql).toContain('workspace_id = $1');expect(current().sql).toContain('sensitivity_rank(ke.sensitivity) <= sensitivity_rank($2)')
  expect(current().sql).toContain('sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($2)');expect(current().sql).toContain('ORDER BY ke.updated_at DESC')
  expectValues(f.workspaceId,'public',500)
 })
 it('returns true when entries exist',async()=>{await seed('a');expect(await store.hasEntries(ctx)).toBe(true)})
 it('returns false when no entries exist',async()=>{expect(await store.hasEntries(ctx)).toBe(false)})
 it('top-level paths exclude actually disabled sources and pass the actual assistant ID',async()=>{
  const source=await store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'fictional/knowledge'})
  const row=await seed('index','Fictional index',{sourceId:source.id});await seed('index/child','Fictional child',{sourceId:source.id})
  expect((await store.listByPath(standard(),'')).map(r=>r.id)).toEqual([row.id])
  await store.setSourceDisabled({assistantId:f.assistantId,sourceId:source.id,disabled:true,userId:f.ownerId})
  expect(await store.listByPath(standard(),'')).toEqual([])
  expect(current().sql).toContain('assistant_disabled_knowledge_sources');expect(current().sql).toContain('adks.source_id = ke.source_id');expect(current().sql).toContain('adks.source_id = ke2.source_id')
  expectValues(f.workspaceId,'confidential',f.assistantId)
 })
 it('getByPath excludes an actually disabled source',async()=>{
  const source=await store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'fictional/knowledge'})
  const row=await seed('products/vault','Fictional source',{sourceId:source.id})
  expect((await store.getByPath(standard(),row.path))?.id).toBe(row.id)
  await store.setSourceDisabled({assistantId:f.assistantId,sourceId:source.id,disabled:true,userId:f.ownerId})
  expect(await store.getByPath(standard(),row.path)).toBeNull()
  expect(current().sql).toContain('adks.assistant_id = $4');expectValues(f.workspaceId,row.path,'confidential',f.assistantId)
 })
 it('resolves a shared path only when one candidate is visible or a source is supplied',async()=>{
  const ordinary=await store.createSource({workspaceId:f.workspaceId,sourceType:'github',repo:'fictional/ordinary'})
  const restricted=await store.createSource({workspaceId:f.workspaceId,sourceType:'github',repo:'fictional/restricted'})
  const manual=await seed('index','Fictional manual')
  const repo=await seed('index','Fictional repo',{sourceId:ordinary.id})
  await seed('index','Fictional restricted',{sourceId:restricted.id,sensitivity:'confidential'})
  const internal={...standard(),clearance:'internal' as const}
  expect(await store.getByPath(internal,'index')).toBeNull()
  expect(await store.getByPath(internal,'index',undefined,ordinary.id)).toMatchObject({id:repo.id})
  expect(await store.getByPath(internal,'index',undefined,restricted.id)).toBeNull()
  expect(await store.getByPath(internal,'index',undefined,null)).toMatchObject({id:manual.id})
  await store.setSourceDisabled({assistantId:f.assistantId,sourceId:ordinary.id,disabled:true,userId:f.ownerId})
  expect(await store.getByPath(internal,'index')).toMatchObject({id:manual.id})
  expect(await store.getByPath(standard(),'index')).toBeNull()
 })
 it('the real primary reflector keeps its existing cross-source query behavior',async()=>{
  const source=await store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'fictional/knowledge'})
  const row=await seed('products/vault','Fictional source',{content:'Fictional vault',sourceId:source.id})
  await store.setSourceDisabled({assistantId:f.assistantId,sourceId:source.id,disabled:true,userId:f.ownerId})
  expect((await store.search(ctx,'vault')).map(r=>r.id)).toEqual([row.id])
  expect(current().sql).not.toContain('assistant_disabled_knowledge_sources');expectValues(f.workspaceId,'vault',10,'confidential')
 })
})
