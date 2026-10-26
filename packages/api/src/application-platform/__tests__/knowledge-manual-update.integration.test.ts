import type {PoolClient} from 'pg'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {createKnowledgeTools,type ToolContext} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {retainedKnowledgeFixture} from './fixtures/retained-knowledge.js'
import {knowledgeFieldPolicyFixture} from './fixtures/knowledge-field-policy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof retainedKnowledgeFixture>>
type Policy=Awaited<ReturnType<typeof knowledgeFieldPolicyFixture>>
describe.sequential('[COMP:api/application-persistence] actual native manual Knowledge body updates',()=>{
 let saved:Fixture|undefined,policy:Policy|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);try{await policy?.cleanup()}finally{policy=undefined;await saved?.cleanup();saved=undefined}})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 const rule={id:'fictional-manual-update-rule',name:'Fictional body revision',instructions:'Save the approved fictional revision',targetSourceId:null,targetLabel:'Manual entries',pathPrefix:'',defaultSensitivity:'confidential' as const}
 const tools=createKnowledgeTools(store,{allowWrites:true,captureRules:[rule]}),read=tools.find(t=>t.name==='readKnowledgeEntry')!,update=tools.find(t=>t.name==='updateKnowledgeEntry')!
 async function setup(){saved=await retainedKnowledgeFixture();configureConnectorSourceRuntimeFactory(saved.source.factory,{instances:saved.source.instances});return saved}
 async function consumed(f:Fixture,userId:Fixture['f']['ownerId']=f.f.ownerId){const context=await f.context(userId,true),result=await read.execute({id:f.row.id},context);expect(result.isError,JSON.stringify(result)).not.toBe(true);if(!result.scopeEvidence?.sources?.length)throw new Error('Actual source observations required');context.scopeAccumulator.note(result.scopeEvidence);return context}
 const input=(id:string,content='Fictional revised Knowledge bytes')=>({id,content,changeSummary:'Revise the fictional body',captureRuleId:rule.id})
 async function raw(f:Fixture,id=f.row.id){return(await f.f.pool.query('SELECT id,content,scope_version::text AS version,created_by FROM knowledge_entries WHERE workspace_id=$1 AND id=$2',[f.f.workspaceId,id])).rows[0]}
 async function target(f:Fixture){return store.create({workspaceId:f.f.workspaceId,path:'fictional-authored-update-target',title:'Fictional authored revision target',content:'Fictional original target bytes',sensitivity:'confidential',compartments:[...f.source.root.compartments],projectIds:[...f.source.root.projectIds],createdBy:f.f.ownerId})}
 it('keeps complete original field and source observations on the new canonical version and returns currently bound output evidence',async()=>{
  const f=await setup(),context=await consumed(f),original=structuredClone(context.scopeAccumulator.evidence.sources!),before=await raw(f)
  expect((await f.f.pool.query(`SELECT count(*)::int AS count FROM knowledge_entry_revision_values v JOIN knowledge_entry_revision_publications p ON p.workspace_id=v.workspace_id AND p.revision_id=v.revision_id WHERE p.workspace_id=$1 AND p.entry_id=$2`,[f.f.workspaceId,f.row.id])).rows[0].count).toBe(0)
  const result=await update.execute(input(f.row.id),context)
  expect(result.isError,JSON.stringify(result)).not.toBe(true)
  const row=await raw(f);expect(row.content).toBe(input(f.row.id).content);expect(row.version).not.toBe(before.version);expect(row.created_by).toBe(before.created_by)
  const edges=(await f.f.pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM knowledge_entry_revision_publications p JOIN scope_derivations d ON d.workspace_id=p.workspace_id AND d.resource_kind='knowledge_entry_revision' AND d.resource_id=p.revision_id AND d.resource_version='1' JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id WHERE p.workspace_id=$1 AND p.entry_id=$2 AND p.entry_version=$3`,[f.f.workspaceId,row.id,row.version])).rows
  for(const source of original)expect(edges).toContainEqual({source_kind:source.resourceKind,source_id:source.resourceId,source_version:source.version})
  const lineage=(await f.f.pool.query('SELECT * FROM application_scope_lineage($1,$2,$3,$4)',[f.f.workspaceId,['knowledge_entry'],[row.id],[row.version]])).rows
  for(const source of original)expect(lineage).toContainEqual({kind:source.resourceKind,id:source.resourceId,version:source.version})
  expect(result.scopeEvidence?.sources?.some(source=>source.resourceKind==='knowledge_entry'&&source.resourceId===row.id&&source.version===row.version)).toBe(true)
  const current=await read.execute({id:row.id},await f.context(f.f.secondId,true));expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(current.data).toMatchObject({content:input(row.id).content})
  await f.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.f.ownerId])
  const held=await read.execute({id:row.id},await f.context(f.f.ownerId,true));expect(held.isError).toBe(true);expect(JSON.stringify(held)).not.toContain(input(row.id).content)
  const other=await read.execute({id:row.id},await f.context(f.f.secondId,true));expect(other.isError,JSON.stringify(other)).not.toBe(true);expect(other.data).toMatchObject({content:input(row.id).content})
 })
 it('refuses a revoked destination write role before UPDATE with the source still readable and keeps a separate current writer usable',async()=>{
  const f=await setup(),destination=await target(f);policy=await knowledgeFieldPolicyFixture(f.f,{requireBodyWriter:true});await policy.grant(f.f.ownerId,'body_writer');await policy.grant(f.f.secondId,'body_writer')
  const first=await consumed(f),other=await consumed(f,f.f.secondId),original=structuredClone(first.scopeAccumulator.evidence),otherOriginal=structuredClone(other.scopeAccumulator.evidence),before=await raw(f,destination.id)
  const priorRead=await read.execute({id:destination.id},await f.context(f.f.ownerId,true));expect(priorRead.isError,JSON.stringify(priorRead)).not.toBe(true)
  const publicationCounts=async()=>(await f.f.pool.query(`SELECT
   (SELECT count(*)::int FROM knowledge_entry_scope_revisions WHERE workspace_id=$1 AND entry_id=$2) AS revisions,
   (SELECT count(*)::int FROM knowledge_entry_revision_publications WHERE workspace_id=$1 AND entry_id=$2) AS publications,
   (SELECT count(*)::int FROM knowledge_entry_revision_fields field JOIN knowledge_entry_scope_revisions revision ON revision.workspace_id=field.workspace_id AND revision.id=field.revision_id WHERE revision.workspace_id=$1 AND revision.entry_id=$2) AS fields,
   (SELECT count(*)::int FROM knowledge_entry_revision_values value JOIN knowledge_entry_scope_revisions revision ON revision.workspace_id=value.workspace_id AND revision.id=value.revision_id WHERE revision.workspace_id=$1 AND revision.entry_id=$2) AS values`,[f.f.workspaceId,destination.id])).rows[0]
  const beforePublications=await publicationCounts()
  await policy.revoke(f.f.ownerId,'body_writer');const fresh=await f.context(f.f.ownerId,true);fresh.scopeAccumulator.note(original)
  // This client trace covers direct statements; server-side publication conservation is asserted separately.
  let writes=0;const queries=new Map<PoolClient,PoolClient['query']>(),trace=(client:PoolClient)=>{if(queries.has(client))return;const old=client.query;queries.set(client,old);client.query=function(...args:unknown[]){if(typeof args[0]==='string'&&/UPDATE knowledge_entries\s+SET content/.test(args[0]))writes++;return Reflect.apply(old,client,args)} as typeof client.query}
  getAppPool().on('acquire',trace)
  try{const held=await update.execute(input(destination.id),fresh);expect(held.isError,JSON.stringify(held)).toBe(true);expect(writes).toBe(0)}finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
  expect(await raw(f,destination.id)).toEqual(before);expect(await publicationCounts()).toEqual(beforePublications)
  const current=await f.context(f.f.secondId,true);current.scopeAccumulator.note(otherOriginal);const success=await update.execute(input(destination.id),current);expect(success.isError,JSON.stringify(success)).not.toBe(true);expect((await raw(f,destination.id)).content).toBe(input(destination.id).content)
 })
 it('does not replace a readable authored target using copied source observations without the original execution',async()=>{
  const f=await setup(),destination=await target(f),original=await consumed(f),before=await raw(f,destination.id),missing:ToolContext={...original,executionContext:undefined}
  const result=await update.execute(input(destination.id),missing);expect(result.isError,JSON.stringify(result)).toBe(true);expect(await raw(f,destination.id)).toEqual(before)
 })
 it('keeps every earlier field observation through successive actual body revisions and denies a withdrawn field reader independently',async()=>{
  const f=await setup();policy=await knowledgeFieldPolicyFixture(f.f)
  const first=await consumed(f),original=structuredClone(first.scopeAccumulator.evidence.sources!),one=await update.execute(input(f.row.id,'Fictional second body version'),first);expect(one.isError,JSON.stringify(one)).not.toBe(true)
  const next=await consumed(f,f.f.secondId),currentInputs=structuredClone(next.scopeAccumulator.evidence.sources!),two=await update.execute(input(f.row.id,'Fictional third body version'),next);expect(two.isError,JSON.stringify(two)).not.toBe(true)
  const row=await raw(f),lineage=(await f.f.pool.query('SELECT * FROM application_scope_lineage($1,$2,$3,$4)',[f.f.workspaceId,['knowledge_entry'],[row.id],[row.version]])).rows
  for(const source of [...original,...currentInputs])expect(lineage).toContainEqual({kind:source.resourceKind,id:source.resourceId,version:source.version})
  expect((await f.f.pool.query('SELECT entry_version FROM knowledge_entry_revision_publications WHERE workspace_id=$1 AND entry_id=$2 ORDER BY entry_version',[f.f.workspaceId,row.id])).rows.map(row=>row.entry_version)).toEqual(['1','2','3'])
  expect(row).toMatchObject({version:'3',content:'Fictional third body version'})
  const pairs=(await f.f.pool.query(`SELECT p.entry_version,
   count(fields.field_key)::int AS fields,count(payload.field_key)::int AS values,
   bool_and(fields.value_sha256=application_field_digest(payload.value)) AS digests_match,
   cardinality(application_knowledge_field_keys()) AS expected_fields
   FROM knowledge_entry_revision_publications p
   LEFT JOIN knowledge_entry_revision_fields fields ON fields.workspace_id=p.workspace_id AND fields.revision_id=p.revision_id
   LEFT JOIN knowledge_entry_revision_values payload ON payload.workspace_id=fields.workspace_id AND payload.revision_id=fields.revision_id AND payload.field_key=fields.field_key
   WHERE p.workspace_id=$1 AND p.entry_id=$2 GROUP BY p.entry_version ORDER BY p.entry_version`,[f.f.workspaceId,row.id])).rows
  expect(pairs).toHaveLength(3)
  for(const pair of pairs){expect(pair.fields).toBe(pair.expected_fields);expect(pair.values).toBe(pair.expected_fields);expect(pair.digests_match).toBe(true)}
  expect((await f.f.pool.query("SELECT has_function_privilege('app_user','publish_native_knowledge_body_revision(uuid,uuid,text,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
  await policy.revoke(f.f.ownerId,'body_reader')
  const held=await read.execute({id:row.id},await f.context(f.f.ownerId,true));expect(held.isError).toBe(true);expect(JSON.stringify(held)).not.toContain('Fictional third body version')
  const other=await read.execute({id:row.id},await f.context(f.f.secondId,true));expect(other.isError,JSON.stringify(other)).not.toBe(true);expect(other.data).toMatchObject({content:'Fictional third body version'})
  // The actual nonowner runtime login has no private retained-value table access.
  const runtime=await getAppPool().connect()
  try{
   const identity=(await runtime.query(`SELECT session_user,current_user,r.rolsuper,r.rolbypassrls,
    pg_has_role(r.oid,c.relowner,'USAGE') AS owner FROM pg_roles r
    JOIN pg_class c ON c.oid='public.knowledge_entry_revision_values'::regclass WHERE r.rolname=session_user`)).rows[0]
   expect(identity).toEqual({session_user:'app_user',current_user:'app_user',rolsuper:false,rolbypassrls:false,owner:false})
   await runtime.query('BEGIN')
   await expect(runtime.query('SELECT value FROM knowledge_entry_revision_values LIMIT 1')).rejects.toMatchObject({code:'42501'})
  }finally{await runtime.query('ROLLBACK');runtime.release()}
 })
 it('preserves post-commit uncertainty after a real role contraction while the other reader still sees the durable revision',async()=>{
  const f=await setup();policy=await knowledgeFieldPolicyFixture(f.f);const context=await consumed(f),before=await raw(f)
  let revoked=0;const queries=new Map<PoolClient,PoolClient['query']>(),written=new WeakSet<PoolClient>()
  const trace=(client:PoolClient)=>{if(queries.has(client))return;const original=client.query;queries.set(client,original);client.query=function(...args:unknown[]){
   const sql=typeof args[0]==='string'?args[0]:'';if(sql.includes('FROM update_admitted_knowledge_entry_body('))written.add(client)
   const result=Reflect.apply(original,client,args)
   if(sql==='COMMIT'&&written.has(client)){written.delete(client);return Promise.resolve(result).then(async value=>{revoked++;await policy!.revoke(f.f.ownerId,'body_reader');return value})}
   return result
  } as typeof client.query}
  getAppPool().on('acquire',trace)
  let result
  try{result=await update.execute(input(f.row.id),context)}finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
  const row=await raw(f);expect(row.content).toBe(input(row.id).content);expect(row.version).not.toBe(before.version);expect(revoked).toBe(1)
  expect(result.isError).toBe(true);expect(result.meta).toMatchObject({retrySafe:false,operationMayHaveExecuted:true});expect(JSON.stringify(result)).not.toMatch(/Nothing was saved|did not run|still holds its previous body/);expect(JSON.stringify(result)).not.toContain(input(row.id).content)
  const other=await read.execute({id:row.id},await f.context(f.f.secondId,true));expect(other.isError,JSON.stringify(other)).not.toBe(true);expect(other.data).toMatchObject({content:input(row.id).content})
 })
})
