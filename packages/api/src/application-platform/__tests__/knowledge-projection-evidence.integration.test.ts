import {spawn} from 'node:child_process'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator,boundScopeSources,createKnowledgeTools,executionToolContext,scopeEvidenceFromRows,type LLMProvider} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {generateTitle} from '../../routes/attended-session-title.js'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
describe.sequential('[COMP:api/application-persistence] actual knowledge projection provenance',()=>{
 let f:Fixture|undefined
 afterEach(async()=>{await f?.cleanup();f=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function fixture(related:boolean,confidential=true){
  f=await persistentContextFixture(confidential?'confidential':'internal');const current=f
  const parent=await store.create({workspaceId:current.workspaceId,path:'fictional',title:'Fictional knowledge parent',content:'Fictional parent body',sensitivity:'internal',createdBy:current.ownerId})
  const child=await store.create({workspaceId:current.workspaceId,path:'fictional/child',title:'Fictional child knowledge',content:'Fictional child body',sensitivity:confidential?'confidential':'internal',createdBy:current.ownerId})
  if(related)await current.pool.query('UPDATE knowledge_entries SET related_ids=ARRAY[$2::uuid] WHERE id=$1',[parent.id,child.id])
  const execution=await current.execution()
  const source=async(id:string)=>(await current.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[current.workspaceId,id])).rows[0].source
  return{f:current,parent,child,execution,source}
 }
 for(const projection of ['point relation','graph relation','child count'] as const)it(`preserves exact ${projection} contributors and their classification before mapping`,async()=>{
  const c=await fixture(projection!=='child count'),access=c.execution.security.access
  const row=projection==='point relation'?await store.getById(access,c.parent.id):projection==='graph relation'?
   (await store.listForGraph(access,10)).find(row=>row.id===c.parent.id):(await store.listByPath(access,'')).find(row=>row.id===c.parent.id)
  expect(row).toBeDefined()
  if(projection==='child count')expect(row).toMatchObject({childCount:1})
  else expect(row).toMatchObject({relatedIds:[c.child.id]})
  const sources=boundScopeSources(row!)
  expect(sources.filter(source=>source.resourceKind==='knowledge_entry').map(source=>source.resourceId).sort()).toEqual([c.parent.id,c.child.id].sort())
  const fields=sources.filter(source=>source.resourceKind==='application_field')
  const observations=(await c.f.pool.query(`SELECT r.selection,r.resource_id FROM application_field_resources r
   JOIN application_field_observations o ON o.workspace_id=r.workspace_id AND o.resource_id=r.id
   WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.type_key='knowledge_entry'`,[c.f.workspaceId,fields.map(source=>source.resourceId)])).rows
  if(projection==='point relation'){
   expect(fields).toHaveLength(2);expect(sources).toHaveLength(4)
   expect(observations.filter(row=>row.selection==='read').map(row=>row.resource_id)).toEqual([c.parent.id])
   expect(observations.filter(row=>row.selection==='identity').map(row=>row.resource_id)).toEqual([c.child.id])
  }else{
   const graph=projection==='graph relation'
   expect(fields).toHaveLength(graph?4:3);expect(sources).toHaveLength(graph?6:5)
   expect(observations.filter(row=>row.selection==='query').map(row=>row.resource_id).sort()).toEqual([c.parent.id,c.child.id].sort())
   expect(observations.filter(row=>row.selection==='query_domain')).toHaveLength(1)
   expect(observations.filter(row=>row.selection==='identity').map(row=>row.resource_id)).toEqual(graph?[c.child.id]:[])
  }
  expect(sources).toEqual(expect.arrayContaining([expect.objectContaining({resourceId:c.child.id,version:(await c.source(c.child.id)).version,sensitivity:'confidential'})]))
  expect(scopeEvidenceFromRows([row]).sensitivity).toBe('confidential')
 })
 it('refuses actual cached knowledge tool projection before title extraction/provider use after a contributor is held, while another fresh reader can use the parent',async()=>{
  const c=await fixture(true,false),accumulator=new ContextScopeAccumulator(),context={...executionToolContext(c.execution,{appId:'native-knowledge-projection'}),scopeAccumulator:accumulator}
  const tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  const result=await tool.execute({id:c.parent.id},context)
  expect(result.data).toMatchObject({relatedEntries:[c.child.id]})
  if(!result.scopeEvidence)throw new Error('Actual knowledge tool must retain its source evidence')
  accumulator.note(result.scopeEvidence)
  await expect(assertSourceModelInputAuthority(context)).resolves.toBeUndefined()
  const before=await c.source(c.parent.id)
  await c.f.pool.query('UPDATE knowledge_entries SET scope_held=true WHERE id=$1',[c.child.id])
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-knowledge-projection',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},
   stream:async function*(){calls++;yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional projection title'};
    yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  const messages=[{role:'user' as const,get content(){extractions++;return JSON.stringify(result.data)}}]
  await expect(generateTitle(provider,messages,'fixture',()=>assertSourceModelInputAuthority(context))).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
  expect(await c.source(c.parent.id)).toEqual(before)
  const other=await c.f.execution(c.f.secondId),otherAccumulator=new ContextScopeAccumulator(),otherContext={...executionToolContext(other,{appId:'native-knowledge-projection'}),scopeAccumulator:otherAccumulator}
  const current=await tool.execute({id:c.parent.id},otherContext)
  expect(current.isError).not.toBe(true)
  expect(current.data).toHaveProperty('relatedEntries',undefined)
  expect(JSON.stringify(current.data)).not.toContain(c.child.id)
  if(!current.scopeEvidence)throw new Error('Fresh knowledge reader must retain its parent evidence')
  expect(current.scopeEvidence.sources?.filter(source=>source.resourceKind==='knowledge_entry').map(source=>source.resourceId)).toEqual([c.parent.id])
  const fields=current.scopeEvidence.sources?.filter(source=>source.resourceKind==='application_field')??[]
  expect(fields).toHaveLength(1);expect(current.scopeEvidence.sources).toHaveLength(2)
  expect((await c.f.pool.query(`SELECT resource_id,selection FROM application_field_resources WHERE workspace_id=$1 AND id=$2`,[c.f.workspaceId,fields[0].resourceId])).rows)
   .toEqual([{resource_id:c.parent.id,selection:'read'}])
  otherAccumulator.note(current.scopeEvidence)
  await expect(assertSourceModelInputAuthority(otherContext)).resolves.toBeUndefined()
 })
 it('holds a real misconfigured owner-pool reader even with copied current member GUCs',async()=>{
  const c=await fixture(false,false)
  expect(await store.getById(c.execution.security.access,c.parent.id)).not.toBeNull()
  const script=`const {assertLocalFixture}=await import('./scripts/crm/local-fixture.mjs');await assertLocalFixture();
   process.env.DATABASE_URL_APP=process.env.DATABASE_URL;
   const db=await import('./packages/api/src/db/client.ts');
   const {createDbKnowledgeStore}=await import('./packages/api/src/db/knowledge-store.ts');
   const input=JSON.parse(process.argv[1]);const store=createDbKnowledgeStore();
   const role=(await db.getAppPool().query("SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass FROM pg_roles r JOIN pg_class c ON c.oid='knowledge_entries'::regclass WHERE r.rolname=current_user")).rows[0];
   if(role?.bypass!==true)throw new Error('Synthetic comparison must use its real table owner');
   const point=await store.getById(input.access,input.id),exists=await store.hasEntries(input.access),paths=await store.listPaths(input.access);
   console.log('R3_OWNER_PROOF:'+JSON.stringify({point:!!point,exists,paths}));const app=db.getAppPool(),system=db.getPool();await app.end();if(system!==app)await system.end();`
  const output=await new Promise<string>((resolve,reject)=>{
   const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,JSON.stringify({access:c.execution.security.access,id:c.parent.id})],
    {cwd:new URL('../../../../../',import.meta.url),env:process.env,stdio:['ignore','pipe','pipe']})
   let stdout='',stderr='';child.stdout.on('data',part=>{stdout+=part});child.stderr.on('data',part=>{stderr+=part})
   child.on('error',reject);child.on('close',code=>code===0?resolve(stdout):reject(new Error(`Synthetic owner comparison failed (${code}): ${stderr}`)))
  })
  const result=output.split('\n').find(line=>line.startsWith('R3_OWNER_PROOF:'))
  if(!result)throw new Error('Synthetic owner comparison returned no proof')
  expect(JSON.parse(result.slice('R3_OWNER_PROOF:'.length))).toEqual({point:false,exists:false,paths:[]})
 })
 it('excludes a foreign workspace relation even when the viewer is a member of both workspaces',async()=>{
  const c=await fixture(true,false),other=await persistentContextFixture()
  try{
   await c.f.pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",[other.workspaceId,c.f.ownerId])
   const foreign=await store.create({workspaceId:other.workspaceId,path:'foreign',title:'Fictional foreign entry',content:'Fictional foreign body',sensitivity:'internal',createdBy:other.ownerId})
   await c.f.pool.query('UPDATE knowledge_entries SET related_ids=ARRAY[$2::uuid] WHERE id=$1',[c.parent.id,foreign.id])
   expect(await store.getById(c.execution.security.access,c.parent.id)).toMatchObject({relatedIds:[]})
  }finally{await other.cleanup()}
 })
})
