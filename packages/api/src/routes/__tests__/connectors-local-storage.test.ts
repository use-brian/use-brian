import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import { connectorRoutes } from '../connectors.js'
import { createTestApp } from './helpers.js'

const WS = '11111111-1111-1111-1111-111111111111'
const USER = 'user_1'

function makeApp(over: { isAdmin?: boolean; existing?: { id: string } | null } = {}) {
  const createWorkspaceInstance = vi.fn(async () => ({ id: 'inst_new' }))
  const update = vi.fn(async () => ({ id: 'inst_existing' }))
  const setConfigSystem = vi.fn(async () => {})
  const findByWorkspaceProviderSystem = vi.fn(async () => over.existing ?? null)
  const connectorInstanceStore = {
    createWorkspaceInstance,
    update,
    setConfigSystem,
    findByWorkspaceProviderSystem,
  } as unknown as ConnectorInstanceStore
  const router = connectorRoutes({
    connectorStore: {} as ConnectorStore,
    connectorInstanceStore,
    localStorage: { requireWorkspaceAdmin: async () => over.isAdmin ?? true },
  })
  const app = createTestApp('/api/connectors', router, { userId: USER })
  return { app, createWorkspaceInstance, update, setConfigSystem }
}

describe('[COMP:api/connectors-route] local directory storage', () => {
  it('connects an existing writable directory as a workspace storage instance', async () => {
    // realpath: the route canonicalizes the path, and on macOS tmpdir() (/tmp)
    // is a symlink to /private/tmp — assert against the canonical form.
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'brian-files-')))
    try {
      const { app, createWorkspaceInstance } = makeApp()
      const res = await request(app).post('/api/connectors/local/connect').send({ workspaceId: WS, path: dir })

      expect(res.status).toBe(200)
      expect(createWorkspaceInstance).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: WS,
        provider: 'local',
        credentials: { type: 'local', path: dir },
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a missing directory and a non-admin caller', async () => {
    const missing = await request(makeApp().app)
      .post('/api/connectors/local/connect')
      .send({ workspaceId: WS, path: '/definitely/missing/use-brian-path' })
    expect(missing.status).toBe(400)

    const dir = await mkdtemp(join(tmpdir(), 'brian-files-denied-'))
    try {
      const denied = await request(makeApp({ isAdmin: false }).app)
        .post('/api/connectors/local/connect')
        .send({ workspaceId: WS, path: dir })
      expect(denied.status).toBe(403)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('disconnects by wiping the local binding credential', async () => {
    const { app, update, setConfigSystem } = makeApp({ existing: { id: 'inst_existing' } })
    const res = await request(app).post('/api/connectors/local/disconnect').send({ workspaceId: WS })

    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(USER, 'inst_existing', {
      connected: false,
      credentials: { type: 'none' },
    })
    expect(setConfigSystem).toHaveBeenCalledWith('inst_existing', expect.objectContaining({
      disconnectedAt: expect.any(String),
    }))
  })
})
