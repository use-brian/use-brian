/** Real shared OAuth and permission boundaries. [COMP:api/external-services] */
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbOAuthClientStore} from '../../db/oauth-client-store.js'
import {createDbOAuthAuthorizationStore} from '../../db/oauth-authorization-store.js'
import {createWorkspaceStore} from '../../db/workspace-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {externalServicesRoutes} from '../../routes/external-services.js'
import {createWorkspaceFile} from '../../db/workspace-files.js'
import {loadExternalServiceAccessSystem} from '../context.js'
import {applicationOnboardingFromNextPath} from '../../application-platform/onboarding.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe('[COMP:api/external-services] native registered service OAuth and current authority',()=>{
 const pool=getPool(),workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),department=randomUUID(),otherDepartment=randomUUID(),project=randomUUID()
 const secret='fictional-external-service-native-secret',redirectUri='https://erp.example/callback',clients:string[]=[]
 const app=express();app.use(express.json());app.use('/api/external-services',externalServicesRoutes({clientStore:createDbOAuthClientStore(),workspaceStore:createWorkspaceStore(),requireAuth:requireAuth(secret),signingSecret:secret,webAppUrl:'https://host.example',origins:['https://host.example']}))
 let ownerToken:string,memberToken:string,outsiderToken:string
 async function native(user:string){const session=await authSessionStore.create(user,{deviceLabel:'Fictional test browser',userAgent:null,ipAddress:null});if(!session)throw Error('session');return createTokens(user,secret,session).accessToken}
 beforeAll(async()=>{
  for(const user of [owner,member,outsider])await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[user])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional service workspace',$2)",[workspaceId,owner])
  for(const [user,role] of [[owner,'owner'],[member,'member']])await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'internal')",[workspaceId,user,role])
  for(const d of [department,otherDepartment])await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional department',$3,'team',$1::text,$4)",[d,workspaceId,owner,`team:${d}`])
  await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspaceId,department,member])
  await pool.query("UPDATE workspaces SET department_read_v2=true,project_shared_spaces=true WHERE id=$1",[workspaceId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fictional project','fictional project',$3)",[project,workspaceId,owner])
  await pool.query("INSERT INTO project_shared_scopes(project_id,workspace_id,origin,status) VALUES($1,$2,'created','active')",[project,workspaceId])
  await pool.query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,user_id,origin) VALUES($1,$2,'user',$3,'invited')",[workspaceId,project,member])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional canonical assistant',$2,$3,'primary','confidential')",[randomUUID(),owner,workspaceId])
  ownerToken=await native(owner);memberToken=await native(member);outsiderToken=await native(outsider)
 })
 afterAll(async()=>{await pool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);if(clients.length)await pool.query('DELETE FROM oauth_clients WHERE client_id=ANY($1::text[])',[clients]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,member,outsider]]);await getAppPool().end();await pool.end()})
 async function register(){const r=await request(app).post(`/api/external-services/workspaces/${workspaceId}`).set('Authorization',`Bearer ${ownerToken}`).send({name:'Fictional ERP',redirectUris:[redirectUri]});expect(r.status,JSON.stringify(r.body)).toBe(201);clients.push(r.body.clientId);return r.body as {id:string;clientId:string}}
 async function consent(service:{id:string;clientId:string},userToken=memberToken,scope:'read'|'read_write'='read_write'){const verifier=randomBytes(32).toString('base64url'),base=`/api/external-services/${service.id}/oauth`
  const r=await request(app).get(`${base}/authorize`).query({client_id:service.clientId,redirect_uri:redirectUri,response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope,state:'fictional-state'})
  expect(r.status).toBe(302);const url=new URL(r.headers.location),signed=url.searchParams.get('req')!;expect(url.searchParams.get('service')).toBe('1')
  const review=await request(app).get(`${base}/consent`).set('Authorization',`Bearer ${userToken}`).query({req:signed})
  return {base,verifier,signed,review}
 }
 async function connect(service:{id:string;clientId:string},scope:'read'|'read_write'='read_write'){const c=await consent(service,memberToken,scope);expect(c.review.status,JSON.stringify(c.review.body)).toBe(200)
  const allowed=await request(app).post(`${c.base}/consent`).set('Authorization',`Bearer ${memberToken}`).send({req:c.signed,decision:'allow',workspaceId,review:c.review.body.application.review})
  expect(allowed.status,JSON.stringify(allowed.body)).toBe(200);const code=new URL(allowed.body.redirectUrl).searchParams.get('code')!
  const tokenBody={grant_type:'authorization_code',client_id:service.clientId,redirect_uri:redirectUri,code,code_verifier:c.verifier}
  expect((await request(app).post(`${c.base}/token`).type('form').send({...tokenBody,code_verifier:'x'.repeat(43)})).status).toBe(400)
  const token=await request(app).post(`${c.base}/token`).type('form').send(tokenBody);expect(token.status,JSON.stringify(token.body)).toBe(200)
  return {base:c.base,token:token.body.access_token as string,refresh:token.body.refresh_token as string,tokenBody}
 }
 it('requires a native owner/admin for registration and safe redirect metadata',async()=>{
  for(const token of [memberToken,outsiderToken])expect((await request(app).post(`/api/external-services/workspaces/${workspaceId}`).set('Authorization',`Bearer ${token}`).send({name:'Fictional ERP',redirectUris:[redirectUri]})).status).toBe(403)
  expect((await request(app).post(`/api/external-services/workspaces/${workspaceId}`).set('Authorization',`Bearer ${ownerToken}`).send({name:'Fictional ERP',redirectUris:['http://unsafe.example/callback']})).status).toBe(400)
 })
 it('uses real PKCE consent, single-use codes, current department tiers and shared Project modes without module admission',async()=>{
  const service=await register(),c=await connect(service)
  const context=await request(app).get(`/api/external-services/${service.id}/context`).set('Authorization',`Bearer ${c.token}`)
  expect(context.status,JSON.stringify(context.body)).toBe(200);expect(context.body).toMatchObject({version:1,workspaceId,userId:member,scope:'read_write',clearance:'internal',projectMode:'shared',departmentRead:{base:'internal',departments:{[department]:'confidential'},projects:{[project]:'member'}},departmentCompartments:{[department]:`team:${department}`},departmentNames:{[department]:'Fictional department'},projectNames:{[project]:'Fictional project'}})
  expect(context.body.departmentRead.departments[otherDepartment]).toBeUndefined();expect(context.body.departmentNames[otherDepartment]).toBeUndefined()
  expect((await request(app).post(`${c.base}/token`).type('form').send(c.tokenBody)).status).toBe(400)
  expect(await createDbOAuthAuthorizationStore().getByIdSystem(context.body.authorizationId)).toBeNull()
  const other=await register();expect((await request(app).get(`/api/external-services/${other.id}/context`).set('Authorization',`Bearer ${c.token}`)).status).toBe(401)
  expect((await request(app).get(`/api/external-services/${service.id}/context`).set('Authorization',`Bearer ${memberToken}`)).status).toBe(401)
  const before=context.body.revision
  await pool.query("UPDATE department_edges SET clearance='public' WHERE department_id=$1 AND user_id=$2",[department,member])
  const reduced=await request(app).get(`/api/external-services/${service.id}/context`).set('Authorization',`Bearer ${c.token}`)
  expect(reduced.body.revision).not.toBe(before);expect(reduced.body.departmentRead.departments[department]).toBe('public')
  await pool.query("UPDATE department_edges SET clearance='confidential' WHERE department_id=$1 AND user_id=$2",[department,member])
 })
 it('rejects outsiders and reviewed access changes; recognizes service sign-in continuation',async()=>{
  const service=await register(),c=await consent(service)
  expect(await applicationOnboardingFromNextPath(`/oauth/authorize?application=${service.id}&service=1&req=${encodeURIComponent(c.signed)}`,secret)).toBe('application')
  expect((await consent(service,outsiderToken)).review.status).toBe(403)
  await pool.query("UPDATE department_edges SET expires_at=now()-interval '1 minute' WHERE department_id=$1 AND user_id=$2",[department,member])
  const stale=await request(app).post(`${c.base}/consent`).set('Authorization',`Bearer ${memberToken}`).send({req:c.signed,decision:'allow',workspaceId,review:c.review.body.application.review})
  expect(stale.status).toBe(409)
  await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[department,member])
 })
 it('rotates refresh tokens and rejects old access, replay and revoked authorization',async()=>{
  const service=await register(),c=await connect(service),refresh={grant_type:'refresh_token',client_id:service.clientId,refresh_token:c.refresh}
  const rotated=await request(app).post(`${c.base}/token`).type('form').send(refresh);expect(rotated.status).toBe(200)
  expect((await request(app).post(`${c.base}/token`).type('form').send(refresh)).status).toBe(400)
  expect((await request(app).get(`/api/external-services/${service.id}/context`).set('Authorization',`Bearer ${c.token}`)).status).toBe(401)
  expect((await request(app).post(`${c.base}/revoke`).type('form').send({token:rotated.body.refresh_token})).status).toBe(200)
  expect((await request(app).get(`/api/external-services/${service.id}/context`).set('Authorization',`Bearer ${rotated.body.access_token}`)).status).toBe(401)
  expect((await request(app).post(`${c.base}/token`).type('form').send({...refresh,refresh_token:rotated.body.refresh_token})).status).toBe(400)
 })
 it('reconciles the same service/user canonical receipt after renewed consent without sharing receipt ownership',async()=>{
  const service=await register(),first=await connect(service)
  const original={key:'create_company',command:{idempotencyKey:randomUUID(),input:{name:'Fictional renewed-consent client',domain:'recovery.example'}}}
  const post=(target:typeof service,token:string,kind:string,body=original)=>request(app).post(`/api/external-services/${target.id}/canonical/${kind}`).set('Authorization',`Bearer ${token}`).send(body)
  const created=await post(service,first.token,'command');expect(created.status,JSON.stringify(created.body)).toBe(200)
  const renewed=await connect(service)
  expect((await post(service,first.token,'reconcile')).status).toBe(401)
  const reconciled=await post(service,renewed.token,'reconcile');expect(reconciled.status,JSON.stringify(reconciled.body)).toBe(200)
  expect(reconciled.body).toEqual({state:'applied',receipt:created.body})
  expect((await post(service,renewed.token,'command')).body).toEqual(created.body)
  expect((await post(service,renewed.token,'reconcile',{...original,command:{...original.command,input:{...original.command.input,name:'Changed original input'}}})).status).toBe(409)
  const other=await register(),otherGrant=await connect(other)
  const isolated=await post(other,otherGrant.token,'reconcile');expect(isolated.status).toBe(200);expect(isolated.body).toEqual({state:'uncertain'})
 })
 it('creates, replays, reads and patches canonical CRM through OAuth without an ERP module',async()=>{
  const service=await register(),c=await connect(service),base=`/api/external-services/${service.id}/canonical`
  const post=(kind:string,body:object)=>request(app).post(`${base}/${kind}`).set('Authorization',`Bearer ${c.token}`).send(body)
  const command={key:'create_company',command:{idempotencyKey:randomUUID(),input:{name:'Fictional external client',domain:'client.example'}}}
  const created=await post('command',command);expect(created.status,JSON.stringify(created.body)).toBe(200)
  expect(created.body.effect).toBe('committed');expect(created.body.resources).toHaveLength(1)
  const ref=created.body.resources[0];expect(ref.workspaceId).toBe(workspaceId);expect(ref.typeKey).toBe('company')
  const replay=await post('command',command);expect(replay.status,JSON.stringify(replay.body)).toBe(200);expect(replay.body).toEqual(created.body)
  const read=await post('query',{key:'get',input:{type:'company',id:ref.id,fields:['name','domain']}})
  expect(read.status,JSON.stringify(read.body)).toBe(200);expect(read.body.values.name).toBe('Fictional external client')
  const reconciled=await post('reconcile',command);expect(reconciled.status,JSON.stringify(reconciled.body)).toBe(200)
  expect(reconciled.body.state).toBe('applied')
  const update=await post('command',{key:'patch_company',command:{idempotencyKey:randomUUID(),expectedVersion:read.body.ref.version,input:{id:ref.id,patch:{name:'Fictional updated client'}}}})
  expect(update.status,JSON.stringify(update.body)).toBe(200)
  const scope=await loadExternalServiceAccessSystem(workspaceId,member);expect(scope).not.toBeNull()
  const memberRead=await post('query',{key:'get',input:{type:'workspace_member',id:member,fields:['id']}})
  expect(memberRead.status,JSON.stringify(memberRead.body)).toBe(200);expect(memberRead.body.values.id).toBe(member);expect(memberRead.body.ref.id).toBe(member)
  const roster=await post('query',{key:'member_candidates',input:{query:member,limit:5}})
  expect(roster.status,JSON.stringify(roster.body)).toBe(200);expect(roster.body.members).toHaveLength(1);expect(roster.body.members[0]).toMatchObject({displayName:member,record:{ref:{id:member},values:{id:member}}})
  const absentMember=await post('query',{key:'get',input:{type:'workspace_member',id:outsider,fields:['id']}});expect(absentMember.status).toBe(403)
  const fabricated=await post('query',{key:'get',input:{type:'company',id:randomUUID(),fields:['name']}});expect(fabricated.status).toBe(403)
  expect((await pool.query("SELECT count(*)::int AS n FROM application_clients WHERE workspace_id=$1 AND module_key='erp'",[workspaceId])).rows[0].n).toBe(0)
 })
 it('discovers only currently authorized file projections through the canonical owner',async()=>{
  const file=await createWorkspaceFile(owner,{workspaceId,path:`/${randomUUID()}.pdf`,parentPath:'/',name:'Fictional visible agreement.pdf',title:'Fictional visible agreement',mime:'application/pdf',sizeBytes:23,storageUri:'fixture://visible-agreement',createdByUserId:owner,compartments:[],projectIds:[],sensitivity:'internal'})
  const privateFile=await createWorkspaceFile(owner,{workspaceId,path:`/${randomUUID()}.pdf`,parentPath:'/',name:'Fictional private agreement.pdf',title:'Fictional private agreement',mime:'application/pdf',sizeBytes:44,storageUri:'fixture://private-agreement',createdByUserId:owner,userId:owner,compartments:[],projectIds:[],sensitivity:'internal'})
  const service=await register(),c=await connect(service)
  const result=await request(app).post(`/api/external-services/${service.id}/canonical/query`).set('Authorization',`Bearer ${c.token}`).send({key:'file_candidates',input:{query:'agreement',limit:25}})
  expect(result.status,JSON.stringify(result.body)).toBe(200)
  expect(result.body.records.map((record:{ref:{id:string}})=>record.ref.id)).toContain(file.id)
  expect(result.body.records.map((record:{ref:{id:string}})=>record.ref.id)).not.toContain(privateFile.id)
  const projection=result.body.records.find((record:{ref:{id:string}})=>record.ref.id===file.id)
  expect(projection.values).toMatchObject({name:'Fictional visible agreement.pdf',mimeType:'application/pdf',sizeBytes:23})
  expect(JSON.stringify(result.body)).not.toContain('fixture://')
 })
 it('retains read-only consent at canonical writes and enforces access-token expiry',async()=>{
  const service=await register(),c=await connect(service,'read')
  const denied=await request(app).post(`/api/external-services/${service.id}/canonical/command`).set('Authorization',`Bearer ${c.token}`)
   .send({key:'create_company',command:{idempotencyKey:randomUUID(),input:{name:'Fictional denied client'}}})
  expect(denied.status).toBe(403)
  const context=await request(app).get(`/api/external-services/${service.id}/context`).set('Authorization',`Bearer ${c.token}`)
  expect(context.body.scope).toBe('read')
  await pool.query("UPDATE oauth_authorizations SET access_token_expires_at=now()-interval '1 minute' WHERE id=$1",[context.body.authorizationId])
  expect((await request(app).get(`/api/external-services/${service.id}/context`).set('Authorization',`Bearer ${c.token}`)).status).toBe(401)
 })
 it('shares native service management between HTTP and real MCP calls',async()=>{
  async function rpc(args:object,token=ownerToken){const r=await request(app).post(`/api/external-services/workspaces/${workspaceId}/mcp`).set('Authorization',`Bearer ${token}`).set('Accept','application/json, text/event-stream')
   .send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'externalServiceManagement',arguments:args}})
   expect(r.status,r.text).toBe(200);const raw=r.text.split('\n').find(line=>line.startsWith('data: '));return raw?JSON.parse(raw.slice(6)):r.body
  }
  const registered=await rpc({kind:'register',input:{name:'Fictional MCP service',redirectUris:[redirectUri]}})
  expect(registered.result.isError).not.toBe(true);const value=JSON.parse(registered.result.content[0].text);clients.push(value.clientId)
  const listed=await request(app).get(`/api/external-services/workspaces/${workspaceId}`).set('Authorization',`Bearer ${ownerToken}`)
  expect(listed.body.services.some((s:{id:string})=>s.id===value.id)).toBe(true)
  expect((await rpc({kind:'revoke',serviceId:value.id},memberToken)).result.isError).toBe(true)
  expect((await rpc({kind:'revoke',serviceId:value.id})).result.isError).not.toBe(true)
  const after=await request(app).get(`/api/external-services/workspaces/${workspaceId}`).set('Authorization',`Bearer ${ownerToken}`)
  expect(after.body.services.find((s:{id:string})=>s.id===value.id).status).toBe('revoked')
 })
 it('ends current context and refresh on service revocation, and membership removal',async()=>{
  const service=await register(),c=await connect(service)
  expect((await request(app).delete(`/api/external-services/workspaces/${workspaceId}/${service.id}`).set('Authorization',`Bearer ${ownerToken}`)).status).toBe(204)
  expect((await request(app).get(`/api/external-services/${service.id}/context`).set('Authorization',`Bearer ${c.token}`)).status).toBe(401)
  expect((await request(app).post(`${c.base}/token`).type('form').send({grant_type:'refresh_token',client_id:service.clientId,refresh_token:c.refresh})).status).toBe(400)
  const another=await register(),active=await connect(another)
  await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,member])
  expect(await loadExternalServiceAccessSystem(workspaceId,member)).toBeNull()
  expect((await request(app).get(`/api/external-services/${another.id}/context`).set('Authorization',`Bearer ${active.token}`)).status).toBe(401)
  expect((await request(app).post(`${active.base}/token`).type('form').send({grant_type:'refresh_token',client_id:another.clientId,refresh_token:active.refresh})).status).toBe(400)
 })
})
