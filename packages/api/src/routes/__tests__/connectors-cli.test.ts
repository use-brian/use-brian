import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import { connectorRoutes } from '../connectors.js'
import { createTestApp } from './helpers.js'

const USER = 'user_1'
const INSTANCE_ID = '11111111-1111-1111-1111-111111111111'

vi.mock('../../mcp/cli-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp/cli-transport.js')>()
  return {
    ...actual,
    discoverCliServer: vi.fn(async (params, name) => ({
      name,
      url: `stdio://${params.binaryPath}`,
      tools: [{ name: 'status', description: 'Read status', inputSchema: { type: 'object' } }],
    })),
  }
})

function makeApp() {
  const createUserInstance = vi.fn(async () => ({ id: INSTANCE_ID }))
  const get = vi.fn(async () => ({
    id: INSTANCE_ID,
    provider: 'cli',
    label: 'Local tools',
    connected: true,
    config: { cwd: '/tmp/use-brian-mcp-test' },
  }))
  const getAuthCredentials = vi.fn(async () => ({
    type: 'cli' as const,
    binaryPath: '/usr/bin/node',
    args: ['/tmp/server.js'],
  }))
  const connectorInstanceStore = { createUserInstance, get, getAuthCredentials } as unknown as ConnectorInstanceStore
  const router = connectorRoutes({
    connectorStore: {} as ConnectorStore,
    connectorInstanceStore,
  })
  return { app: createTestApp('/api/connectors', router, { userId: USER }), createUserInstance, get, getAuthCredentials }
}

describe('[COMP:api/connectors-cli-route] CLI connector routes', () => {
  it('probes and stores an executable MCP binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brian-cli-'))
    const binaryPath = join(dir, 'mcp-server')
    await writeFile(binaryPath, '#!/bin/sh\nexit 0\n')
    await chmod(binaryPath, 0o700)
    try {
      const { app, createUserInstance } = makeApp()
      const res = await request(app).post('/api/connectors/cli/connect').send({
        label: 'Local tools',
        binaryPath,
        args: ['--stdio'],
        env: { MODE: 'safe' },
        cwd: dir,
        timeoutMs: 20_000,
      })

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ ok: true, connectorInstanceId: INSTANCE_ID, toolCount: 1 })
      expect(createUserInstance).toHaveBeenCalledWith({
        userId: USER,
        provider: 'cli',
        label: 'Local tools',
        connected: true,
        credentials: { type: 'cli', binaryPath, args: ['--stdio'] },
        config: { binaryPath, env: { MODE: 'safe' }, cwd: dir, timeoutMs: 20_000 },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects shell binaries and invalid launch configuration', async () => {
    const { app } = makeApp()
    expect((await request(app).post('/api/connectors/cli/connect').send({ label: 'Shell', binaryPath: '/bin/sh' })).status).toBe(400)
    expect((await request(app).post('/api/connectors/cli/connect').send({ label: 'Tool', binaryPath: '/bin/true', cwd: 'relative' })).status).toBe(400)
    expect((await request(app).post('/api/connectors/cli/connect').send({ label: 'Tool', binaryPath: '/bin/true', env: { PORT: 3000 } })).status).toBe(400)
    expect((await request(app).post('/api/connectors/cli/connect').send({ label: 'Tool', binaryPath: '/bin/true', timeoutMs: 10 })).status).toBe(400)
  })

  it('discovers the selected CLI instance tools live', async () => {
    const { app, get, getAuthCredentials } = makeApp()
    const res = await request(app).get(`/api/connectors/${INSTANCE_ID}/tools`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      serverName: 'Local tools',
      tools: [{
        name: 'status',
        description: 'Read status',
        classification: 'read',
        policy: 'allow',
      }],
    })
    expect(get).toHaveBeenCalledWith(USER, INSTANCE_ID)
    expect(getAuthCredentials).toHaveBeenCalledWith(USER, INSTANCE_ID)
  })

  it('returns reviewable instance config without environment values', async () => {
    const { app } = makeApp()
    const res = await request(app).get(`/api/connectors/cli/${INSTANCE_ID}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      connector: {
        id: INSTANCE_ID,
        label: 'Local tools',
        binaryPath: '/usr/bin/node',
        args: ['/tmp/server.js'],
        cwd: '/tmp/use-brian-mcp-test',
        timeoutMs: 30_000,
        envKeys: [],
      },
    })
  })
})
