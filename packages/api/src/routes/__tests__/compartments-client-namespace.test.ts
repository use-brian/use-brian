/**
 * [COMP:api/compartment-routes] — the reserved `client:*` namespace at the
 * config surface.
 *
 * Client compartments are machine-minted, one per external principal, and
 * never registered (decision D9). Two consequences are asserted here: they do
 * not appear in the Studio picker payload, and they cannot be handed to a
 * member or an assistant as a grant.
 *
 * The picker filter is belt-and-braces today — `KEY_RE` forbids a colon, so
 * `workspace_compartments` cannot hold one. It is here because the cardinality
 * of this namespace is per-client: if any future path did register one, a
 * picker filtering by rule degrades gracefully where one filtering by a
 * hard-coded list would not. See `docs/plans/client-principal.md` §8.
 */

import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { compartmentRoutes } from '../compartments.js'

const WS = '11111111-2222-4333-8444-555555555555'
const ASSISTANT = '99999999-8888-4777-8666-555555555555'

function entry(key: string) {
  return { key, label: key, description: null, color: null, workspaceId: WS }
}

function makeApp(over: { list?: unknown[]; registered?: Set<string> } = {}) {
  const list = vi.fn(async () => over.list ?? [])
  const registeredKeysSystem = vi.fn(async () => over.registered ?? new Set(['finance']))
  const setAssistantGrant = vi.fn(async () => true)
  const setMemberGrant = vi.fn(async () => true)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'u-1'
    next()
  })
  app.use(
    '/api/workspaces/:workspaceId/compartments',
    compartmentRoutes({
      compartmentStore: { list, registeredKeysSystem, setAssistantGrant, setMemberGrant } as never,
      workspaceStore: { getRole: vi.fn(async () => 'owner') } as never,
    }),
  )
  return { app, list, setAssistantGrant, setMemberGrant }
}

describe('[COMP:api/compartment-routes] reserved client namespace', () => {
  it('omits client compartments from the picker payload', async () => {
    const { app } = makeApp({
      list: [entry('finance'), entry('client:cust_a'), entry('client:cust_b'), entry('legal')],
    })

    const res = await request(app).get(`/api/workspaces/${WS}/compartments`).expect(200)

    expect(res.body.compartments.map((c: { key: string }) => c.key)).toEqual(['finance', 'legal'])
    expect(JSON.stringify(res.body)).not.toContain('client:')
  })

  it('leaves an ordinary taxonomy untouched', async () => {
    const { app } = makeApp({ list: [entry('finance'), entry('legal')] })
    const res = await request(app).get(`/api/workspaces/${WS}/compartments`).expect(200)
    expect(res.body.compartments).toHaveLength(2)
  })

  it('refuses to grant a client compartment to an assistant, by name', async () => {
    const { app, setAssistantGrant } = makeApp()

    const res = await request(app)
      .put(`/api/workspaces/${WS}/compartments/assistant-grant/${ASSISTANT}`)
      .send({ compartments: ['finance', 'client:cust_a'], defaultCompartments: [] })
      .expect(400)

    // The registry check would reject it too, as "unknown key". Saying
    // "reserved namespace" is what stops the next person from "fixing" the
    // error by registering one.
    expect(res.body.error).toContain('reserved namespace')
    expect(setAssistantGrant).not.toHaveBeenCalled()
  })

  it('refuses a client compartment as an assistant write default', async () => {
    const { app, setAssistantGrant } = makeApp()
    await request(app)
      .put(`/api/workspaces/${WS}/compartments/assistant-grant/${ASSISTANT}`)
      .send({ compartments: null, defaultCompartments: ['client:cust_a'] })
      .expect(400)
    expect(setAssistantGrant).not.toHaveBeenCalled()
  })

  it('refuses to grant a client compartment to a member', async () => {
    const { app, setMemberGrant } = makeApp()
    await request(app)
      .put(`/api/workspaces/${WS}/compartments/member-grant/${ASSISTANT}`)
      .send({ compartments: ['client:cust_a'] })
      .expect(400)
    expect(setMemberGrant).not.toHaveBeenCalled()
  })

  it('still accepts a registered operator compartment', async () => {
    const { app, setAssistantGrant } = makeApp()
    await request(app)
      .put(`/api/workspaces/${WS}/compartments/assistant-grant/${ASSISTANT}`)
      .send({ compartments: ['finance'], defaultCompartments: ['finance'] })
      .expect(200)
    expect(setAssistantGrant).toHaveBeenCalled()
  })

  it('cannot be created through the registry either — the key regex forbids a colon', async () => {
    const { app } = makeApp()
    await request(app)
      .post(`/api/workspaces/${WS}/compartments`)
      .send({ key: 'client:cust_a', label: 'Client A' })
      .expect(400)
  })
})
