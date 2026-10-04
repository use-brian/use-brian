import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  autoExposeOnConnect,
  autoExposeOnConnectMiddleware,
  connectWorkspaceId,
  type AutoExposeDeps,
} from '../auto-expose.js'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const INST = '33333333-3333-4333-8333-333333333333'
const USER = 'u-1'

function deps(overrides: {
  instance?: Record<string, unknown> | null
  sharedWith?: string[]
  member?: boolean
} = {}): AutoExposeDeps & {
  grantStore: { create: ReturnType<typeof vi.fn>; listGrantedWorkspaceIdsForInstanceSystem: ReturnType<typeof vi.fn> }
  instanceStore: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
} {
  const instance = overrides.instance === undefined
    ? { id: INST, scope: 'user', userId: USER, connected: true }
    : overrides.instance
  return {
    grantStore: {
      create: vi.fn().mockResolvedValue({ id: 'g-1' }),
      listGrantedWorkspaceIdsForInstanceSystem: vi.fn().mockResolvedValue(overrides.sharedWith ?? []),
    },
    instanceStore: {
      get: vi.fn().mockResolvedValue(instance),
      update: vi.fn().mockResolvedValue(instance),
    },
    getMembership: vi.fn().mockResolvedValue(
      overrides.member === false ? null : { role: 'member', clearance: 'internal' },
    ),
  } as never
}

describe('[COMP:api/connector-auto-expose] autoExposeOnConnect', () => {
  it('shares a new personal connection with the originating workspace at the member clearance', async () => {
    const d = deps()
    const outcome = await autoExposeOnConnect(d, { userId: USER, workspaceId: WS, connectorInstanceId: INST })
    expect(outcome).toBe('exposed')
    expect(d.grantStore.create).toHaveBeenCalledWith({
      actingUserId: USER,
      connectorInstanceId: INST,
      targetType: 'workspace',
      targetId: WS,
    })
    expect(d.instanceStore.update).toHaveBeenCalledWith(USER, INST, { sensitivity: 'internal' })
  })

  it('leaves an already-shared connector untouched, sensitivity included', async () => {
    const d = deps({ sharedWith: [WS] })
    expect(await autoExposeOnConnect(d, { userId: USER, workspaceId: WS, connectorInstanceId: INST })).toBe('already_exposed')
    expect(d.grantStore.create).not.toHaveBeenCalled()
    expect(d.instanceStore.update).not.toHaveBeenCalled()
  })

  it('shares only with the originating workspace, not others it is already in', async () => {
    const d = deps({ sharedWith: [OTHER_WS] })
    await autoExposeOnConnect(d, { userId: USER, workspaceId: WS, connectorInstanceId: INST })
    expect(d.grantStore.create).toHaveBeenCalledTimes(1)
    expect(d.grantStore.create.mock.calls[0][0].targetId).toBe(WS)
  })

  it('skips workspace-owned instances, non-members, and calls with no workspace', async () => {
    const owned = deps({ instance: { id: INST, scope: 'workspace', userId: null } })
    expect(await autoExposeOnConnect(owned, { userId: USER, workspaceId: WS, connectorInstanceId: INST })).toBe('not_personal')
    const outsider = deps({ member: false })
    expect(await autoExposeOnConnect(outsider, { userId: USER, workspaceId: WS, connectorInstanceId: INST })).toBe('not_member')
    const none = deps()
    expect(await autoExposeOnConnect(none, { userId: USER, workspaceId: null, connectorInstanceId: INST })).toBe('no_workspace')
    for (const d of [owned, outsider, none]) expect(d.grantStore.create).not.toHaveBeenCalled()
  })

  it('never throws: a grant failure is reported, not raised', async () => {
    const d = deps()
    d.grantStore.create.mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await autoExposeOnConnect(d, { userId: USER, workspaceId: WS, connectorInstanceId: INST })).toBe('failed')
    warn.mockRestore()
  })
})

describe('[COMP:api/connector-auto-expose] connectWorkspaceId', () => {
  it('reads the query first, then the body, and rejects non-UUIDs', () => {
    expect(connectWorkspaceId({ query: { workspaceId: WS }, body: { workspaceId: OTHER_WS } } as never)).toBe(WS)
    expect(connectWorkspaceId({ query: {}, body: { workspaceId: WS } } as never)).toBe(WS)
    expect(connectWorkspaceId({ query: { workspaceId: 'nope' }, body: {} } as never)).toBeNull()
  })
})

describe('[COMP:api/connector-auto-expose] autoExposeOnConnectMiddleware', () => {
  function app(d: AutoExposeDeps | null) {
    const a = express()
    a.use(express.json())
    a.use((req, _res, next) => { (req as unknown as { userId: string }).userId = USER; next() })
    const router = express.Router()
    router.use(autoExposeOnConnectMiddleware(d))
    router.post('/gcal/store-credentials', (_req, res) => { res.json({ ok: true, connectorInstanceId: INST }) })
    router.post('/custom', (_req, res) => { res.json({ id: 'x', connectorInstanceId: INST, connector: {} }) })
    router.post('/instances/:id/disconnect', (_req, res) => { res.json({ ok: true, connectorInstanceId: INST }) })
    router.post('/broken', (_req, res) => { res.status(400).json({ error: 'bad', connectorInstanceId: INST }) })
    a.use('/api/connectors', router)
    return a
  }

  it('shares before responding when a connect succeeds inside a workspace', async () => {
    const d = deps()
    const res = await request(app(d)).post(`/api/connectors/gcal/store-credentials?workspaceId=${WS}`).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, connectorInstanceId: INST })
    expect(d.grantStore.create).toHaveBeenCalledTimes(1)
  })

  it('covers routes that answer with connectorInstanceId but no ok flag (custom MCP)', async () => {
    const d = deps()
    await request(app(d)).post(`/api/connectors/custom?workspaceId=${WS}`).send({})
    expect(d.grantStore.create).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a workspace, on disconnect, or on a failed connect', async () => {
    const d = deps()
    await request(app(d)).post('/api/connectors/gcal/store-credentials').send({})
    await request(app(d)).post(`/api/connectors/instances/${INST}/disconnect?workspaceId=${WS}`).send({})
    await request(app(d)).post(`/api/connectors/broken?workspaceId=${WS}`).send({})
    expect(d.grantStore.create).not.toHaveBeenCalled()
  })

  it('is inert when the edition wires no grant store', async () => {
    const res = await request(app(null)).post(`/api/connectors/gcal/store-credentials?workspaceId=${WS}`).send({})
    expect(res.body).toEqual({ ok: true, connectorInstanceId: INST })
  })
})
