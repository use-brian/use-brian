/** One current native proof, with no pooled identity reuse. [COMP:api/application-persistence] */
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest'
import type {SessionContextAuthority} from '@use-brian/core/memory/session-state-types.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {tryNativeInvocationEvidence} from '../../context-scope/native-invocation-evidence.js'
import {admitModelInput,admitModelOutput} from '../../context-scope/admission.js'
import {createWorkspaceFile} from '../../db/workspace-files.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
let f:Awaited<ReturnType<typeof persistentContextFixture>>,authority:SessionContextAuthority,sources:readonly ScopeSource[],messageId:string
let ordinaryRoots:ScopeSource[]
async function cleanContext(){
 const row=(await getAppPool().query(`SELECT current_setting('app.current_user_id',true) actor,
  current_setting('app.agent_workspace_id',true) workspace,current_setting('app.v2_assistant_id',true) assistant,
  current_setting('app.agent_shared_audience',true) audience`)).rows[0]
 expect(row.actor).not.toBe(f.firstId)
 for(const key of ['workspace','assistant','audience'])expect([null,'']).toContain(row[key])
}
describe.sequential('[COMP:api/application-persistence] native context statement',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture()
  messageId=(await f.history())[0].id
  authority=await f.modelContext(f.firstId)
  const capture=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  sources=boundScopeSources(capture)
  const memory=await f.memory('Fictional direct canonical memory')
  const file=await createWorkspaceFile(f.ownerId,{workspaceId:f.workspaceId,path:'/uploads/fictional-direct.txt',
   parentPath:'/uploads',name:'Fictional direct file',mime:'text/plain',sizeBytes:1,storageUri:'fixture://direct-native',createdByUserId:f.ownerId,source:'user'})
  ordinaryRoots=(await f.pool.query<{source:ScopeSource}>(`SELECT read_scope_source($1,kind,id) AS source
   FROM unnest($2::text[],$3::uuid[]) input(kind,id)`,[f.workspaceId,['session_message','memory','workspace_file'],[messageId,memory.id,file.id]])).rows.map(row=>row.source)
  expect(ordinaryRoots.every(Boolean)).toBe(true)
 })
 afterEach(()=>vi.restoreAllMocks())
 afterAll(async()=>{try{await f?.cleanup()}finally{await getAppPool().end();await getPool().end()}})
 it('captures a complete proof in one application statement and releases its context',async()=>{
  const query=vi.spyOn(getAppPool(),'query')
  const admitted=await tryNativeInvocationEvidence(authority.execution,{sources:[...sources]},authority.execution.security.ceiling,'caller')
  expect(admitted).not.toBeNull()
  for(const source of sources)expect(admitted!.sources).toContainEqual(source)
  expect(query).toHaveBeenCalledTimes(1)
  query.mockRestore()
  await cleanContext()
 })
 it.each(['input','output'] as const)('owns complete native %s admission in one statement without separate authority reads',async boundary=>{
  const execution=await f.execution(f.firstId)
  const context={...executionToolContext(execution,{appId:'fixture:complete-admission'}),scopeAccumulator:new ContextScopeAccumulator({sources:[...sources]})}
  const ownerQuery=vi.spyOn(getPool(),'query'),appQuery=vi.spyOn(getAppPool(),'query')
  await (boundary==='input'?admitModelInput:admitModelOutput)(context)
  expect(appQuery).toHaveBeenCalledTimes(1)
  expect(ownerQuery).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  await cleanContext()
 })
 it('rechecks a changed source and releases context after refusal',async()=>{
  await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[messageId])
  try{
   const query=vi.spyOn(getAppPool(),'query')
   await expect(tryNativeInvocationEvidence(authority.execution,{sources:[...sources]},authority.execution.security.ceiling,'caller')).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
   expect(query).toHaveBeenCalledTimes(1)
   query.mockRestore()
   await cleanContext()
  }finally{await f.pool.query('UPDATE session_messages SET scope_held=false WHERE id=$1',[messageId])}
 })
 it('clears local context when the SQL capture raises a contract refusal',async()=>{
  const definition=(await f.pool.query("SELECT pg_get_functiondef('public.conversation_dag(uuid,jsonb,jsonb)'::regprocedure) AS value")).rows[0].value
  await f.pool.query(`CREATE OR REPLACE FUNCTION public.conversation_dag(w uuid,roots jsonb,selectors jsonb)
   RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
   AS $fixture$ BEGIN RAISE EXCEPTION 'Fictional altered evaluator must not execute';END $fixture$`)
  try{
   await expect(tryNativeInvocationEvidence(authority.execution,{sources:[...sources]},authority.execution.security.ceiling,'caller'))
    .rejects.toMatchObject({reason:'caller_evidence_unavailable',cause:{code:'42501',message:'scope_source_changed'}})
   await cleanContext()
  }finally{await f.pool.query(definition)}
 })
 it('keeps a narrowing callback inside the explicit operation and rolls back its refusal',async()=>{
  const refused=new Error('Fictional narrowing refusal'),guard=vi.fn(async()=>{throw refused})
  await expect(tryNativeInvocationEvidence(authority.execution,{sources:[...sources]},authority.execution.security.ceiling,'caller',guard)).rejects.toBe(refused)
  expect(guard).toHaveBeenCalledTimes(1)
  await cleanContext()
 })
 it.each(['session_message','memory','workspace_file'] as const)('admits ordinary %s roots without the field-reader routing sentinel',async kind=>{
  const root=ordinaryRoots.find(source=>source.resourceKind===kind)!
  const appQuery=vi.spyOn(getAppPool(),'query'),ownerQuery=vi.spyOn(getPool(),'query')
  const admitted=await tryNativeInvocationEvidence(authority.execution,{sources:[root]},authority.execution.security.ceiling,'caller')
  expect(admitted?.sources).toContainEqual(root)
  expect(appQuery).toHaveBeenCalledTimes(1)
  expect(ownerQuery).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  await cleanContext()
 })
 it.each(['session_message','memory','workspace_file'] as const)('withholds actual model input and output after ordinary %s is held',async kind=>{
  const root=ordinaryRoots.find(source=>source.resourceKind===kind)!
  const context=async()=>({...executionToolContext(await f.execution(f.firstId),{appId:'fixture:direct-native'}),scopeAccumulator:new ContextScopeAccumulator({sources:[root]})})
  const input=await context(),output=await context()
  await expect(admitModelInput(input)).resolves.toBeUndefined()
  await expect(admitModelOutput(output)).resolves.toBeUndefined()
  await f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
   VALUES($1,$2,$3,$4,'held',1,'Fictional direct source hold')`,[f.workspaceId,kind,root.resourceId,root.version])
  try{
   await expect(admitModelInput(input)).rejects.toMatchObject({reason:'authority_changed'})
   await expect(admitModelOutput(output)).rejects.toMatchObject({reason:'authority_changed'})
  }finally{
   await f.pool.query('DELETE FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind=$2 AND resource_id=$3',[f.workspaceId,kind,root.resourceId])
  }
  await cleanContext()
 })
 it('keeps the original ordinary Memory evidence after native D1 deletion',async()=>{
  const root=ordinaryRoots.find(source=>source.resourceKind==='memory')!,original=structuredClone(root)
  const execution=await f.execution(f.firstId)
  await f.pool.query('DELETE FROM memories WHERE id=$1',[root.resourceId])
  const accumulator=new ContextScopeAccumulator({sources:[root]})
  await expect(admitModelInput({...executionToolContext(execution,{appId:'fixture:direct-d1'}),scopeAccumulator:accumulator})).resolves.toBeUndefined()
  expect(accumulator.evidence.sources).toContainEqual(original)
  expect(accumulator.evidence.sensitivity).toBe(original.sensitivity)
  await cleanContext()
 })
 it.each(['membership','policy'] as const)('refuses fresh %s changes at the combined model boundary',async change=>{
  const execution=await f.execution(f.firstId)
  const context={...executionToolContext(execution,{appId:'fixture:complete-revocation'}),scopeAccumulator:new ContextScopeAccumulator({sources:[...sources]})}
  await admitModelInput(context)
  if(change==='membership')await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  else await f.pool.query('UPDATE application_policy_workspace_epochs SET revision=revision+1 WHERE workspace_id=$1',[f.workspaceId])
  try{
   await expect(admitModelInput(context)).rejects.toMatchObject({reason:'authority_changed'})
  }finally{
   if(change==='membership')await f.pool.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  }
  await expect(admitModelOutput(context)).rejects.toMatchObject({reason:'authority_changed'})
  await cleanContext()
 })

})
