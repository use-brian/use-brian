import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import express from 'express'
import request from 'supertest'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { sourceSignature } from './contracts.js'
import { createTokens } from '../auth/jwt.js'
import { createAuthSessionStore } from '../db/auth-session-store.js'
import { createExternalAppRecordsStore } from './store.js'
import { externalAppRecordsRoutes } from './routes.js'
import { getPool, getAppPool } from '../db/client.js'
import { updateCompany } from '../db/crm.js'
import { resolveWorkspaceViewpoint } from '../db/workspace-viewpoint.js'

const schema=`publication_${randomUUID().replaceAll('-','')}`
const url=process.env.PUBLICATION_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL
if(!url)throw new Error('PUBLICATION_TEST_DATABASE_URL is required for actual PostgreSQL verification')
const dbUrl=new URL(url)
if(!['localhost','127.0.0.1'].includes(dbUrl.hostname)) throw new Error('Local PostgreSQL required')
dbUrl.searchParams.set('options',`-c search_path=${schema},public`)
process.env.DATABASE_URL=dbUrl.href
process.env.DATABASE_URL_APP=dbUrl.href
const admin=new pg.Pool({connectionString:url})
const user=randomUUID(), observer=randomUUID(), outsider=randomUUID(), workspace=randomUUID(), otherWorkspace=randomUUID()
const secret='local-publication-test-secret-only',signingSecret='synthetic-source-signing-secret-only'
let pool:pg.Pool,app:express.Express
const tokens=(id:string)=>createTokens(id,secret).accessToken
const path=(op:string,source='erp')=>`/api/external-app/workspaces/${workspace}/records/${source}/${op}`
function post(op:string,body:Record<string,unknown>,id=user,source='erp') {const authorization=`Bearer ${tokens(id)}`;return request(app).post(path(op,source)).set('Authorization',authorization).set('X-Correlation-ID','publication-test').set('X-Source-Signature',sourceSignature(signingSecret,workspace,source,op,'publication-test',authorization,body)).send(body)}
beforeAll(async()=>{
 await admin.query(`CREATE SCHEMA ${schema}`)
 pool=getPool()
 await pool.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'))
 const migration=await readFile(new URL('./migration.sql',import.meta.url),'utf8')
 expect(migration).toBe(await readFile(new URL('../../migrations/611_external_app_records.sql',import.meta.url),'utf8'))
 await pool.query(migration)
 await pool.query('INSERT INTO users(id) VALUES($1),($2),($3)',[user,observer,outsider])
 await pool.query('INSERT INTO workspaces(id) VALUES($1),($2)',[workspace,otherWorkspace])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[workspace,user,observer])
 const store=createExternalAppRecordsStore({pool,sources:[{workspaceId:workspace,sourceId:'erp',publisherUserIds:[user,outsider],observerUserIds:[observer],appRoles:['erp.staff'],signingSecret}]})
 app=express();app.use(express.json());app.use('/api/external-app',externalAppRecordsRoutes({jwtSecret:secret,sessions:createAuthSessionStore(pool),store}))
},30_000)
afterAll(async()=>{
 await Promise.all([getPool().end(),getAppPool().end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()
})
describe('[COMP:api/external-app-records] actual HTTP authentication, canonical CRM and PostgreSQL',()=>{
 it('authenticates actual signed human tokens and current membership before effects',async()=>{
  expect((await request(app).post(path('publish')).send({})).status).toBe(401)
  expect((await request(app).post(path('publish')).set('Authorization','Bearer machine-key').send({})).status).toBe(401)
  const input={externalId:'denied',version:1,kind:'company',name:'Denied',facts:{}}
  expect((await post('publish',input,outsider)).status).toBe(403)
  expect((await post('publish',input,observer)).status).toBe(403)
  expect((await post('publish',input,user,'missing')).body.error).toBe('source_not_configured')
  expect((await pool.query('SELECT count(*)::int AS n FROM entities')).rows[0].n).toBe(0)
 })
 it('creates canonical companies/deals once under concurrent replay and preserves source facts through native edits',async()=>{
  const input={externalId:'Client:one',version:1,kind:'company',name:'Canonical Co',facts:{approvedProfile:{legalName:'Approved legal name'}}}
  const results=await Promise.all(Array.from({length:5},()=>post('publish',input)))
  expect(results.map(r=>({status:r.status,body:r.body}))).toEqual(Array.from({length:5},()=>({status:200,body:results[0].body})))
  expect(results[0].status).toBe(200)
  const company=results[0].body.entityId
  expect((await pool.query('SELECT count(*)::int AS n FROM entities')).rows[0].n).toBe(1)
  expect((await post('publish',{...input,facts:{wrong:true}})).body.error).toBe('version_conflict')
  const ctx=(await resolveWorkspaceViewpoint(user,workspace))!
  await updateCompany(user,company,{name:'Native UI label'},ctx)
  expect((await post('reconcile',{externalId:input.externalId})).body.facts).toEqual(input.facts)
  await expect(pool.query("UPDATE external_app_record_versions SET payload='{}' WHERE external_id=$1",[input.externalId])).rejects.toThrow('external_app_evidence_immutable')
  const deal={externalId:'Engagement:one',version:1,kind:'deal',name:'E001',companyId:company,facts:{fee:'123.45'}}
  const deals=await Promise.all([post('publish',deal),post('publish',deal)])
  expect(deals[0].status).toBe(200);expect(deals[1].body.entityId).toBe(deals[0].body.entityId)
  expect((await pool.query('SELECT attributes FROM entities WHERE id=$1',[deals[0].body.entityId])).rows[0].attributes.company_id).toBe(company)
  expect((await post('publish',{...input,version:3})).body.version).toBe(3)
  expect((await post('publish',{...input,version:2})).body.error).toBe('stale_version')
  expect((await post('observe',{externalId:input.externalId,providerVersion:2,facts:{approvedProfile:'conflicting observation'}},observer)).status).toBe(200)
  const observed=(await post('reconcile',{externalId:input.externalId})).body
  expect(observed.facts).toEqual(input.facts);expect(observed.observation.providerVersion).toBe(2)
  expect((await post('observe',{externalId:input.externalId,providerVersion:1,facts:{}},observer)).body.error).toBe('stale_provider_version')
  expect((await post('observe',{externalId:input.externalId,providerVersion:2,facts:{}},observer)).body.error).toBe('provider_version_conflict')
 })
 it('links visible canonical IDs, follows merges and undo, refuses foreign/held targets and rolls back failures',async()=>{
  const a=(await post('publish',{externalId:'merge-a',version:1,kind:'company',name:'Merge A',facts:{a:1}})).body.entityId
  const b=(await post('publish',{externalId:'merge-b',version:1,kind:'company',name:'Merge B',facts:{b:1}})).body.entityId
  expect((await post('publish',{externalId:'linked',version:1,kind:'company',name:'Link',entityId:a,facts:{}})).body.entityId).toBe(a)
  await pool.query('UPDATE entities SET valid_to=now(),superseded_by=$2 WHERE id=$1',[a,b])
  expect((await post('reconcile',{externalId:'merge-a'})).body).toMatchObject({entityId:b,originalEntityId:a,merged:true,facts:{a:1}})
  await pool.query('UPDATE entities SET valid_to=NULL,superseded_by=NULL WHERE id=$1',[a])
  expect((await post('reconcile',{externalId:'merge-a'})).body.entityId).toBe(a)
  await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[a])
  expect((await post('reconcile',{externalId:'merge-a'})).status).toBe(403)
  const foreign=randomUUID()
  await pool.query("INSERT INTO entities(id,kind,display_name,workspace_id,created_by_user_id,source) VALUES($1,'company','Foreign',$2,$3,'user')",[foreign,otherWorkspace,user])
  expect((await post('publish',{externalId:'foreign',version:1,kind:'company',name:'X',entityId:foreign,facts:{}})).status).toBe(403)
  expect((await post('publish',{externalId:'bad-deal',version:1,kind:'deal',name:'X',companyId:foreign,facts:{}})).status).toBe(403)
  expect((await pool.query("SELECT * FROM external_app_record_bindings WHERE external_id IN ('foreign','bad-deal')")).rowCount).toBe(0)
 })
 it('requires owning-application attestation as well as the current human; native callers cannot forge approved facts',async()=>{
  const body={externalId:'forged-source',version:1,kind:'company',name:'Synthetic',facts:{approved:true}},authorization=`Bearer ${tokens(user)}`
  const unsigned=await request(app).post(path('publish')).set('Authorization',authorization).set('X-Correlation-ID','publication-test').send(body)
  expect(unsigned.status).toBe(403)
  const signature=sourceSignature(signingSecret,workspace,'erp','publish','publication-test',authorization,body)
  expect((await request(app).post(path('publish')).set('Authorization',authorization).set('X-Correlation-ID','publication-test').set('X-Source-Signature',signature).send({...body,facts:{approved:false}})).status).toBe(403)
  expect((await pool.query("SELECT * FROM external_app_record_bindings WHERE external_id='forged-source'")).rowCount).toBe(0)
 })
 it('retains saved publication audience after a native scope change and requires current membership on replay',async()=>{
  const a=(await post('publish',{externalId:'protected',version:1,kind:'company',name:'Protected',facts:{privateFact:1}})).body.entityId
  await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1',[a,user])
  expect((await post('publish',{externalId:'protected',version:2,kind:'company',name:'Protected',facts:{privateFact:2}})).status).toBe(200)
  await pool.query('UPDATE entities SET user_id=NULL WHERE id=$1',[a])
  expect((await post('reconcile',{externalId:'protected'},observer)).status).toBe(403)
  await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,observer])
  expect((await post('reconcile',{externalId:'Client:one'},observer)).status).toBe(403)
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[workspace,observer])
 })
 it('requests identity or changes scoped app roles, never offboards the workspace; revoked users cannot replay',async()=>{
  const input={externalId:'Employment:one',version:1,userId:null,state:'requested',roles:[]}
  expect((await post('access',input)).status).toBe(200)
  expect((await post('access',{...input,version:2,userId:observer,state:'active',roles:['workspace.admin']})).status).toBe(422)
  expect((await post('access',{...input,version:2,userId:observer,state:'active',roles:['erp.staff']})).body.state).toBe('active')
  expect((await post('access',{...input,version:3,userId:observer,state:'revoked'})).body.state).toBe('revoked')
  expect((await post('access-reconcile',{externalId:input.externalId})).body).toMatchObject({state:'revoked',roles:[],userId:observer,version:3})
  expect((await pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,observer])).rows[0].role).toBe('member')
  await pool.query('UPDATE users SET auth_version=1 WHERE id=$1',[user])
  expect((await post('reconcile',{externalId:'Client:one'})).status).toBe(401)
 })
})
