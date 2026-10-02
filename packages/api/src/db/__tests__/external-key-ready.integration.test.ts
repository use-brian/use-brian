import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { z } from 'zod'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as brainAuth from '../../brain-mcp/auth.js'
import { buildTool, createMemoryTools } from '@use-brian/core'
import { createDbMemoryStore } from '../memory-store.js'
import { createMemory } from '../memories.js'
import { getPool, getAppPool, queryWithRLS } from '../client.js'
import { createDbBrainKeyStore } from '../brain-keys-store.js'
import { createDbApiKeyStore } from '../api-key-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createDbContextScopeStore } from '../context-scope-store.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { brainKeysRoutes } from '../../routes/brain-keys.js'
import { brainMcpRoutes } from '../../brain-mcp/server.js'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { withExternalKeyActor } from '../external-key-admission.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
process.env.PG_POOL_MAX='1'
const pool=getPool(), secret='external-key-integration-only'
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture(onProbe?: () => Promise<void>) {
 const actor=randomUUID(), w=randomUUID(), a=randomUUID()
 await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[actor])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Keys',$2,false)",[w,actor])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[w,actor])
 await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Primary','primary','internal')",[a,w])
 const team=await createDbWorkspaceGroupStore().createTeam(actor,w,{name:'Shared',key:'shared'})
 const project=await createDbContextScopeStore().createProject(actor,w,{name:'Project'})
 const session=(await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'Fixture') RETURNING id",[actor])).rows[0].id
 // Legacy null keys are created before mode setup and must not be relabelled.
 const store=createDbBrainKeyStore()
 const legacy=await store.create({workspaceId:w,actingUserId:actor,name:'Legacy',scope:'read'})
 const legacyApi=await createDbApiKeyStore().create({assistantId:a,actingUserId:actor,name:'Legacy API'})
 await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2,reviewed_inventory_revision=2 WHERE workspace_id=$1",[w,team.id])
 const app=express();app.use(express.json())
 const probe=buildTool({name:'search',description:'Scope probe',inputSchema:z.object({}),isReadOnly:true,
  async execute(_input, context){
   // Observe the production ToolContext projection, not ambient ALS (the
   // search provider installs its own DB scope in normal production use).
   await onProbe?.()
   return {data:context.executionContext!.security.access}
  }})
 const tools=new Proxy({}, {get:(_target,name)=>({...probe,name:String(name)})})
 // Real MCP transport, bearer verification, scope construction and tool wrapper;
 // only the search provider is a deterministic scope-observing fixture.
 app.use('/mcp',brainMcpRoutes({brainKeyStore:store,memoryTools:createMemoryTools(createDbMemoryStore()),taskTools:tools,crmTools:tools,
  retrievalTools:{search:probe,getEntity:probe}} as unknown as Parameters<typeof brainMcpRoutes>[0]))
 app.use(requireAuth(secret))
 app.use('/w/:workspaceId/keys',brainKeysRoutes({brainKeyStore:store,workspaceStore:createWorkspaceStore()}))
 const token=createTokens(actor,secret,{id:session,authVersion:0}).accessToken
 const post=(path:string,body:object={},t=token)=>request(app).post(`/w/${w}/keys${path}`).auth(t,{type:'bearer'}).send(body)
 const create=(extra:object={})=>post('',{name:'Bound',scope:'read',maxClearance:'internal',contextGroupId:team.id,contextProjectId:null,...extra})
 const use=(key:string,name='searchBrain',args:object={})=>request(app).post('/mcp').auth(key,{type:'bearer'}).set('Accept','application/json, text/event-stream')
  .send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})
 const scope=async(key:string)=>{const r=await use(key);expect(r.status,r.text).toBe(200)
  const body=r.body.result?r.body:JSON.parse(r.text.split('\n').find((l:string)=>l.startsWith('data: '))!.slice(6))
  expect(body.result,JSON.stringify(body)).toBeDefined()
  expect(body.result.isError,JSON.stringify(body)).not.toBe(true)
  return JSON.parse(body.result.content[0].text)}
 return {actor,w,a,team,project,session,legacy,legacyApi,store,app,token,post,create,use,scope}
}
describe('A11 ready external key admission: real HTTP and app-role SQL',()=>{
 it('creates, uses and rotates only the secret; mode/default changes cannot expand the ceiling',async()=>{
  const f=await fixture(), created=await f.create()
  expect(created.status,created.text).toBe(200)
  const k=created.body
  expect(await f.scope(k.key)).toMatchObject({compartments:[f.team.compartmentKey],projectIds:[],sharedAudience:true,visibilityAssistantIds:[f.a]})
  await pool.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1",[f.w])
  await pool.query('UPDATE assistants SET default_project_id=$2,default_workspace_group_id=$3 WHERE id=$1',[f.a,f.project.id,f.team.id])
  const bindingBefore=(await pool.query('SELECT configuration_session_id,admitted_compartments,admitted_project_ids,capture_intake_revision FROM brain_keys WHERE id=$1',[k.id])).rows[0]
  const rotated=await f.post(`/${k.id}/rotate`)
  expect(rotated.status,rotated.text).toBe(200)
  expect(rotated.body).toMatchObject({id:k.id,contextGroupId:f.team.id,contextProjectId:null,scope:'read',maxClearance:'internal'})
  expect(rotated.body.key).not.toBe(k.key)
  expect((await pool.query('SELECT configuration_session_id,admitted_compartments,admitted_project_ids,capture_intake_revision FROM brain_keys WHERE id=$1',[k.id])).rows[0]).toEqual(bindingBefore)
  expect((await f.use(k.key)).status).toBe(401)
  expect(await f.scope(rotated.body.key)).toMatchObject({compartments:[f.team.compartmentKey],projectIds:[],sharedAudience:true})
  expect((await f.post(`/${k.id}/rotate`,{contextGroupId:null})).status).toBe(400)
  await expect(queryWithRLS(f.actor,'UPDATE brain_keys SET context_group_id=NULL WHERE id=$1',[k.id])).rejects.toThrow('external_key_rebind_unsupported')
  await expect(queryWithRLS(f.actor,"UPDATE brain_keys SET scope='read_write' WHERE id=$1",[k.id])).rejects.toThrow('external_key_rebind_unsupported')
  const revoked=await request(f.app).delete(`/w/${f.w}/keys/${k.id}`).auth(f.token,{type:'bearer'})
  expect(revoked.status).toBe(204);expect((await f.use(rotated.body.key)).status).toBe(401)
  expect((await f.store.listForWorkspace(f.actor,f.w)).find(r=>r.id===f.legacy.id)).toMatchObject({contextGroupId:null,contextProjectId:null})
 })
 it('pins a Project separately, rejects private and omitted selections, and live-checks archive',async()=>{
  const f=await fixture()
  const k=await f.create({contextProjectId:f.project.id});expect(k.status,k.text).toBe(200)
  expect(await f.scope(k.body.key)).toMatchObject({projectIds:[f.project.id],sharedAudience:true})
  expect((await f.post('',{name:'Omitted'})).status).toBe(409)
  expect((await f.create({contextGroupId:null})).status).toBe(409)
  expect((await f.create({userId:f.actor})).status).toBe(400)
  await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[f.project.id])
  expect((await f.use(k.body.key)).status).toBe(401)
 })
 it('reads shared memories but never private owner or another Project through the actual memory tool',async()=>{
  const f=await fixture()
  const key=await f.create({contextProjectId:f.project.id});expect(key.status,key.text).toBe(200)
  const memory=(summary:string,userId:string|null,projectIds:string[])=>createMemory({assistantId:f.a,
   workspaceId:f.w,userId,createdByUserId:f.actor,summary,sensitivity:'internal',
   compartments:[f.team.compartmentKey!],projectIds})
  const shared=await memory('Shared admitted content',null,[f.project.id])
  const privateRow=await memory('PRIVATE OWNER CONTENT',f.actor,[f.project.id])
  const other=await createDbContextScopeStore().createProject(f.actor,f.w,{name:'Other'})
  const otherProject=await memory('OTHER PROJECT CONTENT',null,[other.id])
  const read=async(token:string,id:string)=>{
   const r=await f.use(token,'getMemory',{id});expect(r.status,r.text).toBe(200)
   const body=r.body.result?r.body:JSON.parse(r.text.split('\n').find((l:string)=>l.startsWith('data: '))!.slice(6))
   expect(body.result,JSON.stringify(body)).toBeDefined();return body.result
  }
  const check=async(token:string)=>{
   const allowed=await read(token,shared.id)
   expect(allowed.isError,JSON.stringify(allowed)).not.toBe(true)
   expect(JSON.stringify(allowed)).toContain('Shared admitted content')
   for(const denied of [privateRow,otherProject]){
    const result=await read(token,denied.id)
    expect(result.isError,JSON.stringify(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(denied.summary)
   }
  }
  await check(key.body.key)
  const rotated=await f.post(`/${key.body.id}/rotate`);expect(rotated.status,rotated.text).toBe(200)
  await check(rotated.body.key)
 })
 it('withholds an HTTP tool result when configuration authority is revoked during execution',async()=>{
  let f: Awaited<ReturnType<typeof fixture>>
  f=await fixture(async()=>{await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[f.session])})
  const k=await f.create();expect(k.status,k.text).toBe(200)
  const r=await f.use(k.body.key);expect(r.status,r.text).toBe(200)
  const body=r.body.result?r.body:JSON.parse(r.text.split('\n').find((l:string)=>l.startsWith('data: '))!.slice(6))
  expect(body.result).toMatchObject({isError:true,content:[{type:'text',text:'Credential or context unavailable. Start a new request.'}]})
  expect((await f.use(k.body.key)).status).toBe(401)
 })
 it.each(['expire','revoke','role'] as const)('checks current configuration authority: %s',async(kind)=>{
  const f=await fixture(), k=await f.create();expect(k.status,k.text).toBe(200)
  if(kind==='expire')await pool.query("UPDATE auth_sessions SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.session])
  if(kind==='revoke')await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[f.session])
  if(kind==='role')await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.actor])
  expect((await f.use(k.body.key)).status).toBe(401)
  expect((await f.post(`/${k.body.id}/rotate`)).status).not.toBe(200)
 })
 it('rejects the authenticated old secret when rotation occurs before context resolution',async()=>{
  let calls=0
  const f=await fixture(async()=>{calls++}), k=await f.create()
  expect(k.status,k.text).toBe(200)
  const authenticate=brainAuth.authenticateBrainRequest
  let newKey=''
  const spy=vi.spyOn(brainAuth,'authenticateBrainRequest').mockImplementationOnce(async(req,opts)=>{
   const auth=await authenticate(req,opts)
   expect(auth?.keyId).toBe(k.body.id) // old secret has actually passed scrypt
   expect(auth).not.toBeNull()
   const proof=brainAuth.getAuthenticatedBrainCredentialCurrent(auth!)
   expect(await proof!()).toBe(true)
   expect(JSON.stringify(auth)).not.toContain('scrypt$')
   expect(brainAuth.getAuthenticatedBrainCredentialCurrent({...auth!})).toBeUndefined()
   expect(brainAuth.getAuthenticatedBrainCredentialCurrent(JSON.parse(JSON.stringify(auth)))).toBeUndefined()
   const rotated=await f.post(`/${k.body.id}/rotate`)
   expect(rotated.status,rotated.text).toBe(200)
   newKey=rotated.body.key
   expect(await proof!()).toBe(false)
   return auth // production server now proceeds to context resolution
  })
  try {
   const r=await f.use(k.body.key);expect(r.status,r.text).toBe(200)
   const body=r.body.result?r.body:JSON.parse(r.text.split('\n').find((l:string)=>l.startsWith('data: '))!.slice(6))
   expect(body.result,JSON.stringify(body)).toMatchObject({isError:true})
   expect(calls).toBe(0)
  } finally {spy.mockRestore()}
  expect(await f.scope(newKey)).toMatchObject({compartments:[f.team.compartmentKey],projectIds:[],sharedAudience:true})
  expect(calls).toBe(1)
  expect((await f.use(k.body.key)).status).toBe(401)
 })
 it('blocks API authority changes across ready/legacy boundaries but permits bookkeeping and revoke',async()=>{
  const f=await fixture(), otherWorkspace=randomUUID(), otherAssistant=randomUUID()
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Legacy source',$2,false)",[otherWorkspace,f.actor])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[otherWorkspace,f.actor])
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind) VALUES($1,$2,'Legacy primary','primary')",[otherAssistant,otherWorkspace])
  const apiStore=createDbApiKeyStore()
  const legacy=await apiStore.create({assistantId:otherAssistant,actingUserId:f.actor,name:'Legacy source key'})
  const role=(await queryWithRLS(f.actor,'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
  expect(role).toEqual({rolsuper:false,rolbypassrls:false})
  // RLS alone permits both destinations: the same actor administers both.
  expect((await apiStore.listForUser(f.actor,f.a)).map(k=>k.id)).toContain(f.legacyApi.id)
  expect((await apiStore.listForUser(f.actor,otherAssistant)).map(k=>k.id)).toContain(legacy.id)
  await expect(queryWithRLS(f.actor,'UPDATE api_keys SET assistant_id=$2 WHERE id=$1',[legacy.id,f.a])).rejects.toThrow('external_key_api_binding_unsupported')
  await expect(queryWithRLS(f.actor,'UPDATE api_keys SET assistant_id=$2 WHERE id=$1',[f.legacyApi.id,otherAssistant])).rejects.toThrow('external_key_api_binding_unsupported')
  for(const id of [f.legacyApi.id,legacy.id]) {
   for(const change of ["scope='agent'","audience='internal'","anonymous_context='full'","tool_policy='assistant'","key_hash='replaced'","key_prefix='replaced'","created_by=NULL","id=gen_random_uuid()"]){
    await expect(queryWithRLS(f.actor,`UPDATE api_keys SET ${change} WHERE id=$1`,[id])).rejects.toThrow('external_key_api_binding_unsupported')
   }
   const touched=await queryWithRLS(f.actor,'UPDATE api_keys SET last_used_at=clock_timestamp() WHERE id=$1 RETURNING status,last_used_at',[id])
   expect(touched.rows[0].status).toBe('active');expect(touched.rows[0].last_used_at).toBeInstanceOf(Date)
   expect(await apiStore.revokeForUser(f.actor,id)).toBe(true)
   expect(await apiStore.revokeForUser(f.actor,id)).toBe(true)
   await expect(queryWithRLS(f.actor,"UPDATE api_keys SET status='active' WHERE id=$1",[id])).rejects.toThrow('external_key_resume_unsupported')
   expect((await queryWithRLS(f.actor,'SELECT status FROM api_keys WHERE id=$1',[id])).rows[0].status).toBe('revoked')
  }
 })
 it('rejects historical/JSON authority, raw app-role writes and unsupported assistant keys',async()=>{
  const f=await fixture()
  expect((await f.create({authSessionId:f.session})).status).toBe(400)
  expect((await f.post('',{name:'No session',contextGroupId:f.team.id,contextProjectId:null,maxClearance:'internal'},createTokens(f.actor,secret).accessToken)).status).toBe(409)
  await expect(f.store.create({workspaceId:f.w,actingUserId:f.actor,name:'Direct',scope:'read',contextGroupId:f.team.id,contextProjectId:null,maxClearance:'internal'})).rejects.toThrow('external_key_review_required')
  await expect(queryWithRLS(f.actor,"INSERT INTO brain_keys(workspace_id,name,key_hash,key_prefix,created_by) VALUES($1,'Raw','hash','prefix',$2)",[f.w,f.actor])).rejects.toThrow('external_key_review_required')
  await expect(withExternalKeyActor(f.actor,f.session,()=>createDbApiKeyStore().create({assistantId:f.a,actingUserId:f.actor,name:'Unsupported'}))).rejects.toThrow('external_key_api_binding_unsupported')
 })
})
