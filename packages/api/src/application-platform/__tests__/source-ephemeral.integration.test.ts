import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {applicationPlatformRoutes} from '../../routes/application-platform.js'
import {ApplicationPlatformService} from '../service.js'
import {ApplicationManagementService} from '../management.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {sourceModeFixture} from './fixtures/source-modes.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/source-ephemeral] retired private host route',()=>{
 afterAll(async()=>{configureConnectorSourceRuntimeFactory(undefined);await getAppPool().end();await getPool().end()})
 it('returns authenticated not found without source/model/persistence activity despite caller lane flags',async()=>{
  const x=await sourceModeFixture(),secret='fictional-retired-route-session',source=vi.fn(async()=>{throw new Error('No source dispatch')})
  try{
   configureConnectorSourceRuntimeFactory(source,{instances:x.instances})
   const session=await authSessionStore.create(x.f.ownerId,{deviceLabel:'Fictional browser',userAgent:'Fixture',ipAddress:'127.0.0.1'})
   const token=createTokens(x.f.ownerId,secret,session!).accessToken,service=new ApplicationPlatformService([]),management=new ApplicationManagementService(service)
   const app=express();app.use(express.json());app.use('/api/applications',applicationPlatformRoutes({service,management:{service:management,requireAuth:requireAuth(secret),origins:['https://private.example']}}))
   const instance=(await x.f.pool.query('SELECT connector_instance_id AS id FROM connector_source_profiles WHERE workspace_id=$1',[x.f.workspaceId])).rows[0].id
   const tables=['session_messages','session_state','external_source_observations','turn_events','turn_payloads']
   const counts=async()=>Promise.all(tables.map(async table=>(await x.f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n))
   const before=await counts(),reads=x.source.counters.reads
   for(const flags of [{},{nonretaining:true,provider:'fictional',qualified:true}]){
    const result=await request(app).post(`/api/applications/workspaces/${x.f.workspaceId}/sources/${instance}/ephemeral`).set('Authorization','Bearer '+token).send({tool:'readRecord',input:{id:'record-1',fields:['description'],retentionMode:'ephemeral'},prompt:'Fictional request',...flags})
    expect(result.status).toBe(404)
   }
   expect(source).not.toHaveBeenCalled();expect(x.source.counters.reads).toBe(reads);expect(await counts()).toEqual(before)
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   await expect((await x.runtime()).runtime.call('readRecord',{id:'record-1',fields:['description'],retentionMode:'ephemeral'})).rejects.toBeDefined()
   expect((await x.f.pool.query('SELECT count(*)::int AS n FROM external_source_observations WHERE workspace_id=$1',[x.f.workspaceId])).rows[0].n).toBe(0)
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
})
