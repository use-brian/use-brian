import type {PoolClient} from 'pg'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {createKnowledgeTools,createKnowledgeSyncWorker,type ToolContext} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {retainedKnowledgeFixture} from './fixtures/retained-knowledge.js'
import {knowledgeFieldPolicyFixture} from './fixtures/knowledge-field-policy.js'
import {createKnowledgeRepoWriter,type RepoWriterGithubOps} from '../../knowledge/repo-writer.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof retainedKnowledgeFixture>>
type Policy=Awaited<ReturnType<typeof knowledgeFieldPolicyFixture>>
describe.sequential('[COMP:api/application-persistence] actual derived manual Knowledge creation',()=>{
 let saved:Fixture|undefined,policy:Policy|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);try{await policy?.cleanup()}finally{policy=undefined;await saved?.cleanup();saved=undefined}})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 const rule={id:'fictional-manual-rule',name:'Fictional manual capture',instructions:'Save the approved fictional Knowledge entry',targetSourceId:null,targetLabel:'Manual entries',pathPrefix:'',defaultSensitivity:'internal' as const}
 const tools=createKnowledgeTools(store,{allowWrites:true,captureRules:[rule]})
 const reader=tools.find(tool=>tool.name==='readKnowledgeEntry')!,creator=tools.find(tool=>tool.name==='addKnowledgeEntry')!
 async function setup(){saved=await retainedKnowledgeFixture();configureConnectorSourceRuntimeFactory(saved.source.factory,{instances:saved.source.instances});return saved}
 async function consumed(c:Fixture,userId=c.f.ownerId){const context=await c.context(userId,true),result=await reader.execute({id:c.row.id},context);expect(result.isError,JSON.stringify(result)).not.toBe(true);expect(result.data).toMatchObject({content:c.row.content});if(!result.scopeEvidence?.sources?.length)throw new Error('Actual source Knowledge read must carry complete observations');context.scopeAccumulator.note(result.scopeEvidence);return context}
 const input=(path:string)=>({path,title:'Fictional derived manual entry',content:'Fictional derived manual bytes',captureRuleId:rule.id})
 async function rows(c:Fixture,path:string){return(await c.f.pool.query('SELECT id FROM knowledge_entries WHERE workspace_id=$1 AND path=$2',[c.f.workspaceId,path])).rows}
 async function repository(c:Fixture, failMirror=false){
  await c.f.pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='ready' WHERE workspace_id=$1",[c.f.workspaceId])
  const source=await store.createSource({workspaceId:c.f.workspaceId,sourceType:'github',repo:'fictional/docs',rootPath:'docs',
   binding:{sensitivity:'confidential',compartments:[],projectIds:[]}},{actorUserId:c.f.ownerId})
  await c.f.pool.query('UPDATE workspace_knowledge_sources SET write_access=true WHERE id=$1',[source.id])
  const remote=new Map<string,string>(),effects:string[]=[]
  const ops:RepoWriterGithubOps={getBranchHead:async()=> 'fictional-head',getRepoTree:async()=>[...remote.keys()].map(path=>({path})),
   getFileContents:async(_pat,_owner,_repo,path)=>({content:remote.get(path)}),
   createOrUpdateFile:async(_pat,_owner,_repo,p)=>{effects.push(p.content);remote.set(p.path,p.content);return{commit:{sha:`fictional-commit-${effects.length}`}}}}
  const backing=failMirror?{...store,publishRepoWrite:async(...args:Parameters<typeof store.publishRepoWrite>)=>store.publishRepoWrite(args[0],args[1],async()=>{await args[2]();throw new Error('fictional mirror failure after source write')})}:store
  const writer=createKnowledgeRepoWriter({store:backing,syncCredentials:{getPat:async()=> 'synthetic-token'},githubOps:ops})
  const capture={...rule,id:'fictional-repo-rule',targetSourceId:source.id,targetLabel:'Fictional repository'}
  const all=createKnowledgeTools(store,{allowWrites:true,repoConnected:true,repoWriter:writer,writableSources:[{id:source.id,repo:source.repo,sourceType:'github'}],captureRules:[capture]})
  return{source,remote,effects,writer,create:all.find(tool=>tool.name==='addKnowledgeEntry')!,update:all.find(tool=>tool.name==='updateKnowledgeEntry')!,input:(path:string)=>({...input(path),captureRuleId:capture.id})}
 }
 it('publishes a source-backed write under the actual retained actor with every original observation and an independent current reader',async()=>{
  const c=await setup(),repo=await repository(c),context=await consumed(c),original=structuredClone(context.scopeAccumulator.evidence.sources!),path='fictional-repo-published'
  const result=await repo.create.execute(repo.input(path),context);expect(result.isError,JSON.stringify(result)).not.toBe(true);expect(repo.effects).toHaveLength(1)
  const [row]=await rows(c,path),stored=(await c.f.pool.query('SELECT source_id,created_by,scope_version FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]
  expect(stored).toMatchObject({source_id:repo.source.id,created_by:c.f.ownerId})
  const graph=(await c.f.pool.query('SELECT * FROM application_scope_lineage($1,$2,$3,$4)',[c.f.workspaceId,['knowledge_entry'],[row.id],[String(stored.scope_version)]])).rows
  for(const source of original)expect(graph).toContainEqual({kind:source.resourceKind,id:source.resourceId,version:source.version})
  expect(graph).toContainEqual({kind:'knowledge_source',id:repo.source.id,version:'1'})
  // Current point reads canonically materialize an immutable capture root.
  // Freeze that root before comparing the complete graph across withdrawal.
  const firstRead=await reader.execute({id:row.id},await c.context(c.f.ownerId,true))
  expect(firstRead.isError,JSON.stringify(firstRead)).not.toBe(true);expect(firstRead.data).toMatchObject({content:repo.input(path).content})
  const capturedGraph=(await c.f.pool.query('SELECT * FROM application_scope_lineage($1,$2,$3,$4)',[c.f.workspaceId,['knowledge_entry'],[row.id],[String(stored.scope_version)]])).rows
  for(const edge of graph)expect(capturedGraph).toContainEqual(edge)
  const before=JSON.stringify(capturedGraph);await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const held=await reader.execute({id:row.id},await c.context(c.f.ownerId,true));expect(held.isError).toBe(true)
  const current=await reader.execute({id:row.id},await c.context(c.f.secondId,true));expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(current.data).toMatchObject({content:repo.input(path).content})
  expect(JSON.stringify((await c.f.pool.query('SELECT * FROM application_scope_lineage($1,$2,$3,$4)',[c.f.workspaceId,['knowledge_entry'],[row.id],[String(stored.scope_version)]])).rows)).toBe(before)
 })
 it('updates a source-backed entry through the actual tool while retaining every earlier observation',async()=>{
  const c=await setup(),repo=await repository(c),context=await consumed(c),original=structuredClone(context.scopeAccumulator.evidence.sources!),path='fictional-repo-update'
  expect((await repo.create.execute(repo.input(path),context)).isError).not.toBe(true)
  const [row]=await rows(c,path),result=await repo.update.execute({id:row.id,content:'Fictional revised repository bytes',changeSummary:'clarify documentation',captureRuleId:repo.input(path).captureRuleId},await consumed(c))
  expect(result.isError,JSON.stringify(result)).not.toBe(true);expect(repo.effects).toHaveLength(2)
  const updated=(await c.f.pool.query('SELECT content,scope_version FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]
  expect(updated.content).toBe('Fictional revised repository bytes')
  const graph=(await c.f.pool.query('SELECT * FROM application_scope_lineage($1,$2,$3,$4)',[c.f.workspaceId,['knowledge_entry'],[row.id],[String(updated.scope_version)]])).rows
  for(const source of original)expect(graph).toContainEqual({kind:source.resourceKind,id:source.resourceId,version:source.version})
 })
 it('refuses a missing matched capture rule before the source-backed update reads or dispatches',async()=>{
  const c=await setup(),repo=await repository(c),before=await c.snapshot()
  const result=await repo.update.execute({id:c.row.id,content:'Fictional refused update',changeSummary:'clarify documentation'},await consumed(c))
  expect(result.isError).toBe(true);expect(String(result.data)).toContain('captureRuleId is required')
  expect(repo.effects).toHaveLength(0);expect(repo.remote.size).toBe(0);expect(await c.snapshot()).toEqual(before)
 })
 it('refuses missing original execution and withdrawn independent source before repository dispatch',async()=>{
  const c=await setup(),repo=await repository(c),context=await consumed(c),missing:ToolContext={...context,executionContext:undefined}
  expect((await repo.create.execute(repo.input('fictional-missing-repo-authority'),missing)).isError).toBe(true);expect(repo.effects).toHaveLength(0)
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  expect((await repo.create.execute(repo.input('fictional-withdrawn-repo-authority'),context)).isError).toBe(true);expect(repo.effects).toHaveLength(0)
 })
 it('refuses a current destination field-write denial before repository dispatch',async()=>{
  const c=await setup(),repo=await repository(c);policy=await knowledgeFieldPolicyFixture(c.f,{requireBodyWriter:true})
  const result=await repo.create.execute(repo.input('fictional-repo-field-held'),await consumed(c))
  expect(result.isError,JSON.stringify(result)).toBe(true);expect(repo.effects).toHaveLength(0)
 })
 it('refuses source-binding and workspace mismatches before repository dispatch',async()=>{
  const c=await setup(),repo=await repository(c),context=await consumed(c),source=(await store.getSource(repo.source.id))!
  const authority={execution:context.executionContext!,accumulator:context.scopeAccumulator!},effect=async()=>{repo.effects.push('forbidden');return{sha:'fictional',url:null}}
  const entry={workspaceId:c.f.workspaceId,path:'fictional-source-mismatch',title:'Fictional',content:'Fictional',sensitivity:'confidential' as const,sourceId:source.id,actorId:c.f.ownerId,compartments:[],projectIds:[]}
  await expect(store.publishRepoWrite({source:{...source,bindingVersion:'999'},entry},authority,effect)).rejects.toThrow()
  await expect(store.publishRepoWrite({source,entry:{...entry,workspaceId:crypto.randomUUID()}},authority,effect)).rejects.toThrow()
  expect(repo.effects).toHaveLength(0)
 })
 it('preserves possible source effect and rolls back the mirror when publication fails after dispatch',async()=>{
  const c=await setup(),repo=await repository(c,true),context=await consumed(c),path='fictional-uncertain-repo'
  const result=await repo.create.execute(repo.input(path),context);expect(repo.effects).toHaveLength(1);expect(await rows(c,path)).toEqual([])
  expect(result).toMatchObject({isError:true,meta:{retrySafe:false,operationMayHaveExecuted:true}});expect(JSON.stringify(result)).not.toMatch(/nothing was committed|retry once/i)
 })
 it('holds worker replacement of a tool-published entry without losing ancestry and keeps ordinary source imports usable',async()=>{
  const c=await setup(),repo=await repository(c),path='fictional-repo-sync-guard'
  expect((await repo.create.execute(repo.input(path),await consumed(c))).isError).not.toBe(true)
  const [row]=await rows(c,path),before=(await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]
  const source=(await store.getSource(repo.source.id))!,sync=(await store.captureSourceSync(source))!
  try{
   await expect(store.upsertByPath({workspaceId:c.f.workspaceId,path,title:'Fictional overwrite',content:'Forbidden replacement',sensitivity:'confidential',sourceId:source.id,sourceSha:'fictional-worker-commit'},sync)).rejects.toThrow('knowledge_repo_reconciliation_required')
   expect((await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]).toEqual(before)
   const plain=await store.upsertByPath({workspaceId:c.f.workspaceId,path:'fictional-ordinary-import',title:'Fictional import',content:'Ordinary source bytes',sensitivity:'confidential',sourceId:source.id,sourceSha:'fictional-worker-commit'},sync)
   expect(plain.content).toBe('Ordinary source bytes')
  }finally{await store.releaseSourceSync(sync)}
 })
 async function nativeRepository(protectedFields=false){
  const c=await setup()
  const native=await store.create({workspaceId:c.f.workspaceId,path:'fictional-native-input',title:'Fictional native input',content:'Original native bytes',sensitivity:'confidential',createdBy:c.f.ownerId})
  const repo=await repository(c)
  if(protectedFields)policy=await knowledgeFieldPolicyFixture(c.f)
  const context=await c.context(c.f.ownerId,true)
  const read=await reader.execute({id:native.id},context);expect(read.isError,JSON.stringify(read)).not.toBe(true)
  context.scopeAccumulator.note(read.scopeEvidence!)
  const original=structuredClone(context.scopeAccumulator.evidence.sources!),path='fictional-native-refresh'
  const result=await repo.create.execute(repo.input(path),context);expect(result.isError,JSON.stringify(result)).not.toBe(true)
  const [row]=await rows(c,path)
  return{c,repo,row,path,original}
 }
 it('refreshes native-only tool publication through the actual worker and preserves immutable original observations across repeat refresh',async()=>{
  const {c,repo,row,path,original}=await nativeRepository(),events:Array<{type:string;error?:string}>=[]
  expect((await c.f.pool.query('SELECT revision_id FROM knowledge_entry_revision_publications WHERE workspace_id=$1 AND entry_id=$2',[c.f.workspaceId,row.id])).rows).toEqual([])
  let head='fictional-refresh-head-1'
  const worker=createKnowledgeSyncWorker({store:{...store,getSourcesDueForSync:async()=>[(await store.getSource(repo.source.id))!]},credentials:{getPat:async()=> 'synthetic-token'},
   api:{getBranchHead:async()=>head,getRepoPermissions:async()=>({push:true}),getRepoTree:async()=>[{path:`docs/${path}.md`,sha:head}],
    getFileContents:async()=>({content:'---\ntitle: Fictional refreshed Knowledge\nsensitivity: confidential\n---\nFresh native source bytes'}),
    compareCommits:async()=>({headSha:head,files:[{filename:`docs/${path}.md`,status:'modified'}]})},onEvent:event=>events.push(event)})
  try{
   for(const next of ['fictional-refresh-head-1','fictional-refresh-head-2']){
    head=next;await worker.tick()
    expect(events.filter(event=>event.type==='sync_error'),JSON.stringify(events)).toEqual([])
    const current=(await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]
    expect(current.content).toBe('Fresh native source bytes');expect(current.source_sha).toBe(head)
    const captures=(await c.f.pool.query(`SELECT r.revision_kind,p.entry_version,(SELECT count(*) FROM knowledge_entry_revision_fields f WHERE f.revision_id=r.id) AS fields,(SELECT count(*) FROM knowledge_entry_revision_values v WHERE v.revision_id=r.id) AS values FROM knowledge_entry_scope_revisions r JOIN knowledge_entry_revision_publications p ON p.workspace_id=r.workspace_id AND p.revision_id=r.id WHERE r.workspace_id=$1 AND r.entry_id=$2 AND r.revision_kind='capture'`,[c.f.workspaceId,row.id])).rows
    expect(captures).toContainEqual({revision_kind:'capture',entry_version:'1',fields:'13',values:'13'})
    const graph=(await c.f.pool.query('SELECT * FROM application_scope_lineage($1,$2,$3,$4)',[c.f.workspaceId,['knowledge_entry'],[row.id],[String(current.scope_version)]])).rows
    for(const source of original)expect(graph).toContainEqual({kind:source.resourceKind,id:source.resourceId,version:source.version})
    expect(graph).toContainEqual({kind:'knowledge_source',id:repo.source.id,version:'1'})
    const direct=(await c.f.pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM knowledge_entry_revision_publications p
     JOIN scope_derivations d ON d.workspace_id=p.workspace_id AND d.resource_kind='knowledge_entry_revision' AND d.resource_id=p.revision_id
     JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
     WHERE p.workspace_id=$1 AND p.entry_id=$2 AND p.entry_version=$3`,[c.f.workspaceId,row.id,String(current.scope_version)])).rows
    for(const source of original.filter(source=>source.resourceKind==='application_field'))expect(direct).toContainEqual({source_kind:source.resourceKind,source_id:source.resourceId,source_version:source.version})
    const read=await reader.execute({id:row.id},await c.context(c.f.ownerId,true));expect(read.isError,JSON.stringify(read)).not.toBe(true);expect(read.data).toMatchObject({content:'Fresh native source bytes'})
   }
   const before=(await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]
   await worker.tick();expect(events.filter(event=>event.type==='sync_error')).toEqual([])
   expect((await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]).toEqual(before)
   const source=(await store.getSource(repo.source.id))!,sync=(await store.captureSourceSync(source))!
   try{
    const same={workspaceId:c.f.workspaceId,path,title:before.title,summary:before.summary,content:before.content,tags:before.tags,metadata:before.metadata,sensitivity:before.sensitivity,sensitivityExplicit:before.sensitivity_explicit,sourceId:source.id,sourceSha:before.source_sha}
    await store.upsertByPath(same,sync)
    expect((await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]).toEqual(before)
   }finally{await store.releaseSourceSync(sync)}
  }finally{worker.stop()}
 })
 it('refuses copied, mismatched SQL lease and withdrawn native authority before a refresh changes the publication',async()=>{
  const {c,repo,row,path}=await nativeRepository(true),source=(await store.getSource(repo.source.id))!,sync=(await store.captureSourceSync(source))!
  const input={workspaceId:c.f.workspaceId,path,title:'Forbidden',content:'Forbidden native refresh',tags:[],sensitivity:'confidential' as const,sourceId:source.id,sourceSha:'fictional-denied-refresh'}
  const before=(await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]
  try{
   await expect(store.upsertByPath(input,{})).rejects.toThrow('knowledge_sync_authority_required')
   const current=(await store.getSource(source.id))!,client=await getAppPool().connect()
   try{
    await client.query('BEGIN');await applyRLSGucs(client,c.f.ownerId)
    await expect(client.query('SELECT * FROM apply_knowledge_source_refresh($1::jsonb,$2::jsonb)',[JSON.stringify({...input,compartments:[],projectIds:[]}),JSON.stringify({...current,syncRunId:crypto.randomUUID()})])).rejects.toThrow('knowledge_source_changed')
   }finally{await client.query('ROLLBACK');client.release()}
   expect((await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]).toEqual(before)
   await policy!.revoke(c.f.ownerId,'body_reader')
   await expect(store.upsertByPath(input,sync)).rejects.toThrow()
   expect((await c.f.pool.query('SELECT * FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]).toEqual(before)
  }finally{await store.releaseSourceSync(sync)}
 })
 it('persists every exact source and field observation through the actual manual create and independently holds the resulting row after withdrawal',async()=>{
  const c=await setup(),context=await consumed(c),sources=context.scopeAccumulator.evidence.sources!,path='fictional-derived-create'
  const result=await creator.execute(input(path),context);expect(result.isError,JSON.stringify(result)).not.toBe(true)
  const [row]=await rows(c,path);expect(row).toBeDefined()
  const edges=(await c.f.pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id WHERE d.workspace_id=$1 AND d.resource_kind='knowledge_entry' AND d.resource_id=$2`,[c.f.workspaceId,row.id])).rows
  expect(edges.map(edge=>[edge.source_kind,edge.source_id,edge.source_version].join(':')).sort()).toEqual([...new Set(sources.map(source=>[source.resourceKind,source.resourceId,source.version].join(':')))].sort())
  expect(result.scopeEvidence?.sources?.some(source=>source.resourceKind==='knowledge_entry'&&source.resourceId===row.id)).toBe(true)
  const before=await c.snapshot();await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const held=await reader.execute({id:row.id},await c.context(c.f.ownerId,true));expect(held.isError).toBe(true);expect(JSON.stringify(held)).not.toContain(input(path).content)
  const current=await reader.execute({id:row.id},await c.context(c.f.secondId,true));expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(current.data).toMatchObject({content:input(path).content});expect(await c.snapshot()).toEqual(before)
 })
 it('refuses a withdrawn source before the actual insert and keeps a separately authorized writer usable',async()=>{
  const c=await setup(),first=await consumed(c),second=await consumed(c,c.f.secondId),before=await c.snapshot()
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const held=await creator.execute(input('fictional-withdrawn-create'),first);expect(held.isError,JSON.stringify(held)).toBe(true);expect(await rows(c,'fictional-withdrawn-create')).toEqual([])
  const current=await creator.execute(input('fictional-current-create'),second);expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(await rows(c,'fictional-current-create')).toHaveLength(1);expect(await c.snapshot()).toEqual(before)
 })
 it('refuses a consumed field whose actual role was withdrawn before the manual write',async()=>{
  const c=await setup();policy=await knowledgeFieldPolicyFixture(c.f);const first=await consumed(c),second=await consumed(c,c.f.secondId)
  await policy.revoke(c.f.ownerId,'body_reader')
  const held=await creator.execute(input('fictional-field-held-create'),first);expect(held.isError,JSON.stringify(held)).toBe(true);expect(await rows(c,'fictional-field-held-create')).toEqual([])
  const originalSecond=structuredClone(second.scopeAccumulator.evidence),freshSecond=await c.context(c.f.secondId,true);freshSecond.scopeAccumulator.note(originalSecond)
  const current=await creator.execute(input('fictional-field-current-create'),freshSecond);expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(await rows(c,'fictional-field-current-create')).toHaveLength(1)
 })
 it('does not turn copied consumed evidence without the original execution into an authored root',async()=>{
  const c=await setup(),original=await consumed(c),missing:ToolContext={...original,executionContext:undefined}
  const result=await creator.execute(input('fictional-missing-host-create'),missing);expect(result.isError,JSON.stringify(result)).toBe(true);expect(await rows(c,'fictional-missing-host-create')).toEqual([])
 })
 it('preserves uncertain publication after actual post-commit contraction and never claims that the committed row was not saved',async()=>{
  const c=await setup();policy=await knowledgeFieldPolicyFixture(c.f);const context=await consumed(c),path='fictional-post-commit-create'
  let revoked=0;const queries=new Map<PoolClient,PoolClient['query']>(),written=new WeakSet<PoolClient>()
  const trace=(client:PoolClient)=>{
   if(queries.has(client))return
   const original=client.query;queries.set(client,original)
   client.query=function(...args:unknown[]){
    const sql=typeof args[0]==='string'?args[0]:''
    if(sql.includes('INSERT INTO knowledge_entries'))written.add(client)
    const result=Reflect.apply(original,client,args)
    if(sql==='COMMIT'&&written.has(client)){written.delete(client);return Promise.resolve(result).then(async value=>{revoked++;await policy!.revoke(c.f.ownerId,'body_reader');return value})}
    return result
   } as typeof client.query
  }
  getAppPool().on('acquire',trace)
  let result
  try{result=await creator.execute(input(path),context)}finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
  expect(revoked).toBe(1);expect(result.isError).toBe(true);expect(await rows(c,path)).toHaveLength(1)
  expect(result.meta).toMatchObject({retrySafe:false,operationMayHaveExecuted:true})
  expect(JSON.stringify(result)).not.toMatch(/Nothing was saved|did not run/)
  expect(JSON.stringify(result)).not.toContain(input(path).content)
  const [row]=await rows(c,path),second=await reader.execute({id:row.id},await c.context(c.f.secondId,true))
  expect(second.isError,JSON.stringify(second)).not.toBe(true);expect(second.data).toMatchObject({content:input(path).content})
 })
})
