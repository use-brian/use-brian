import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import express from 'express'
import request from 'supertest'
import {boundScopeSources} from '@use-brian/core'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {getAppPool,getPool} from '../../db/client.js'
import {addSessionMessage,getSessionMessages} from '../../db/sessions.js'
import * as users from '../../db/users.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {sessionRoutes} from '../../routes/sessions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const secret='fictional-native-history-route-secret'

describe.sequential('[COMP:api/session-history] authenticated browser transcript',()=>{
  let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
  afterEach(async()=>{vi.restoreAllMocks();await fixture?.cleanup();fixture=undefined})
  afterAll(async()=>{await getAppPool().end();await getPool().end()})

  async function setup(){
    fixture=await persistentContextFixture()
    const f=fixture,history=await f.history(),authority=await f.modelContext()
    const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
    const reply=await addSessionMessage({sessionId:f.session.id,role:'assistant',
      content:[{type:'text',text:'Fictional protected reply survives refresh'}],
      derivation:{producer:'fixture:browser-history',sources:boundScopeSources(input)},derivationTarget:f.envelope,authority})
    const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional browser',userAgent:null,ipAddress:null}))!
    const token=createTokens(f.ownerId,secret,device).accessToken
    const app=express();app.use('/sessions',requireAuth(secret),sessionRoutes())
    const get=()=>request(app).get(`/sessions/${f.session.id}/messages`).set('Authorization',`Bearer ${token}`)
    return{f,reply,app,get}
  }

  it('returns a field-dependent saved reply without an owner fallback or recency write',async()=>{
    const {f,reply,get}=await setup()
    expect((await getSessionMessages(f.session.id)).some(row=>row.id===reply.id)).toBe(false)
    const before=(await f.pool.query('SELECT last_active_at FROM sessions WHERE id=$1',[f.session.id])).rows[0].last_active_at
    const response=await get()
    expect(response.status,JSON.stringify(response.body)).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual(expect.arrayContaining([expect.objectContaining({id:reply.id,role:'assistant',content:reply.content})]))
    expect((await f.pool.query('SELECT last_active_at FROM sessions WHERE id=$1',[f.session.id])).rows[0].last_active_at).toEqual(before)
  })

  it('rechecks the original reader after asynchronous profile lookup and withholds withdrawn content',async()=>{
    const {f,reply,get}=await setup(),original=users.getUserProfilesByIds
    vi.spyOn(users,'getUserProfilesByIds').mockImplementation(async ids=>{
      const profiles=await original(ids)
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.ownerId])
      return profiles
    })
    const response=await get()
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('session_history_unavailable')
    expect(JSON.stringify(response.body)).not.toContain(reply.id)
    expect(JSON.stringify(response.body)).not.toContain('Fictional protected reply')
  })

  it('requires a current authenticated reader',async()=>{
    const {f,app,get}=await setup()
    await request(app).get(`/sessions/${f.session.id}/messages`).expect(401)
    await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.ownerId])
    const response=await get()
    expect([403,404]).toContain(response.status)
    expect(JSON.stringify(response.body)).not.toContain('Fictional protected reply')
  })

})
