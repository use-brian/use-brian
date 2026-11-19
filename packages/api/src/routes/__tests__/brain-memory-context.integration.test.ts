/** [COMP:api/memory-context-copy] */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, expect, it, vi } from 'vitest'
import { memoryLearningSchema } from '@use-brian/core/memory/learning.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createMemory } from '../../db/memories.js'
import { readMemoryContext, searchMemoryContext } from '../../memory-context-read.js'
import { brainMemoryContextRoutes } from '../brain-memory-context.js'
import { resolveDelegatedWorkspaceReadAuthority } from '../native-workspace-read-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const secret = 'fictional-memory-context-fixture'
const endpoint = '/api/brain/memories/context'
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function fixture() {
  const [owner, member, outsider, workspaceId, primary, otherAssistant, otherWorkspace, otherPrimary] = Array.from({ length: 8 }, () => randomUUID())
  await pool.query('INSERT INTO users(id,auth_provider_id) SELECT id,id::text FROM unnest($1::uuid[]) id', [[owner, member, outsider]])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional Atlas',$2,false),($3,'Fictional Beacon',$2,false)", [workspaceId, owner, otherWorkspace])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance)
    VALUES ($1,$2,'owner','confidential'),($1,$3,'member','internal'),($4,$2,'owner','confidential')`, [workspaceId, owner, member, otherWorkspace])
  await pool.query(`INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance)
    VALUES ($1,'Atlas primary',$2,$3,'primary','confidential'),($4,'Atlas notebook',$2,$3,'standard','confidential'),
           ($5,'Beacon primary',$6,$3,'primary','confidential')`, [primary, workspaceId, owner, otherAssistant, otherPrimary, otherWorkspace])
  const app = express()
  const observe = vi.fn()
  app.use(express.json())
  app.use('/api/brain', requireAuth(secret), brainMemoryContextRoutes({ secret, observe }))
  const tokenFor = async (userId: string) => {
    const session = await authSessionStore.create(userId, { deviceLabel: 'Fictional browser', userAgent: null, ipAddress: null })
    if (!session) throw new Error('Fixture session missing')
    return createTokens(userId, secret, session).accessToken
  }
  const tokens = { owner: await tokenFor(owner), member: await tokenFor(member), secondSession: await tokenFor(member), outsider: await tokenFor(outsider) }
  return {
    owner, member, workspaceId, otherAssistant, otherWorkspace, otherPrimary, observe,
    save(summary: string, fields?: Partial<Parameters<typeof createMemory>[0]>) {
      return createMemory({ assistantId: primary, userId: null, workspaceId, summary, sensitivity: 'internal',
        createdByUserId: owner, createdByAssistantId: primary, source: 'user', ...fields })
    },
    post(operation: string, body: object, actor: keyof typeof tokens = 'member') {
      return request(app).post(`${endpoint}/${operation}`).set('Authorization', `Bearer ${tokens[actor]}`).send(body)
    },
  }
}

it('filters topics and point reads by workspace, clearance, privacy and learning eligibility', async () => {
  const f = await fixture()
  const detail = 'Retain v1 until the fictional 62-day migration ends.\n日本語の詳細。'
  const current = await f.save('Atlas migration', { detail, assistantId: f.otherAssistant, createdByAssistantId: f.otherAssistant, tags: ['hidden-fixture-tag'] })
  const privateMemory = await f.save('Atlas migration private', { userId: f.owner })
  const confidential = await f.save('Atlas migration confidential', { sensitivity: 'confidential' })
  const tentative = await f.save('Atlas migration tentative', {
    learning: memoryLearningSchema.parse({ version: 1, state: 'candidate', origin: 'inferred' }),
  })
  const foreign = await f.save('Atlas migration foreign', { workspaceId: f.otherWorkspace, assistantId: f.otherPrimary, createdByAssistantId: f.otherPrimary })

  const search = await f.post('search', { workspaceId: f.workspaceId, query: 'migration' })
  expect(search.status, JSON.stringify(search.body)).toBe(200)
  expect(search.headers['cache-control']).toBe('no-store')
  expect(search.body).toEqual({ memories: [{ id: current.id, summary: current.summary }] })
  for (const id of [privateMemory.id, confidential.id, tentative.id, foreign.id]) {
    const denied = await f.post('read', { workspaceId: f.workspaceId, id, purpose: 'copy' })
    expect(denied.status).toBe(404)
    expect(denied.body).toEqual({ error: 'memory_context_unavailable' })
  }
  expect((await f.post('search', { workspaceId: f.workspaceId, query: 'migration' }, 'outsider')).status).toBe(404)
  const selected = await f.post('read', { workspaceId: f.workspaceId, id: current.id, purpose: 'preview' })
  expect(selected.status, JSON.stringify(selected.body)).toBe(200)
  expect(selected.body).toEqual({ memory: { summary: current.summary, detail, updatedAt: current.updatedAt.toISOString() } })
})

it('rechecks access at copy time and accepts a short-lived clipboard receipt once in its issuing session', async () => {
  const f = await fixture()
  const memory = await f.save('A fictional migration', { detail: 'The 62-day constraint.' })
  const call = { workspaceId: f.workspaceId, id: memory.id }
  expect((await f.post('read', { ...call, purpose: 'preview' })).status).toBe(200)
  const copy = await f.post('read', { ...call, purpose: 'copy' })
  expect(copy.status, JSON.stringify(copy.body)).toBe(200)
  const receipt = copy.body.receipt
  expect(receipt).toEqual(expect.any(String))
  expect(f.observe).not.toHaveBeenCalled()
  expect((await f.post('copied', { receipt }, 'secondSession')).status).toBe(404)
  expect((await f.post('copied', { receipt })).status).toBe(204)
  expect((await f.post('copied', { receipt })).status).toBe(204)
  expect(f.observe).toHaveBeenCalledExactlyOnceWith()

  await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.member])
  const revoked = await f.post('read', { ...call, purpose: 'copy' })
  expect(revoked.status).toBe(404)
  expect(revoked.text).not.toContain(memory.summary)
  expect(revoked.body.receipt).toBeUndefined()
})

it('shares task-facing lookup with delegated credentials, rechecking them before later reads', async () => {
  const f = await fixture()
  const memory = await f.save('Fictional migration handoff', { detail: 'Retain v1.' })
  let granted = true
  const delegation = {
    userId: f.member, workspaceId: f.workspaceId, delegationId: randomUUID(),
    abortSignal: new AbortController().signal, credentialCurrent: async () => granted,
  }
  const authority = await resolveDelegatedWorkspaceReadAuthority(delegation)
  expect(await searchMemoryContext(authority, 'migration')).toEqual([{ id: memory.id, summary: memory.summary }])
  expect(await readMemoryContext(authority, memory.id)).toMatchObject({ detail: 'Retain v1.' })
  granted = false
  await expect(readMemoryContext(authority, memory.id)).rejects.toBeDefined()
  await expect(resolveDelegatedWorkspaceReadAuthority(delegation)).rejects.toBeDefined()
})
