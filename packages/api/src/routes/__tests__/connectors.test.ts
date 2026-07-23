/**
 * Unit tests for the OSS built-in connector lifecycle route (/api/connectors).
 * Component tag: [COMP:api/connectors-route].
 *
 * Verifies auth gating, the provider allowlist (derived from
 * OFFICIAL_CONNECTORS), the three store-credentials write paths (primary /
 * createNew / instanceId), the CHANNEL_CREDENTIAL_KEY-missing 503, and the
 * list / disconnect / rename / delete handlers. Stores are mocked, so no DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const mockDiscover = vi.fn()
vi.mock('../../mcp/client.js', () => ({
  discoverMcpServer: (...a: unknown[]) => mockDiscover(...a),
}))

import { connectorRoutes } from '../connectors.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstanceStore, ConnectorInstance } from '../../db/connector-instance-store.js'

const IID = '11111111-1111-1111-1111-111111111111'

function instance(over: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: IID,
    scope: 'user',
    userId: 'u1',
    workspaceId: null,
    provider: 'github',
    label: 'GitHub',
    connectedEmail: null,
    url: null,
    custom: false,
    config: {},
    sensitivity: 'internal',
    connected: true,
    ingestionEnabled: false,
    ingestWorkspaceId: null,
    credentialsType: 'oauth',
    healthStatus: 'ok',
    lastError: null,
    lastCheckedAt: null,
    createdBy: 'u1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

function makeApp(userId?: string) {
  // Keep the vi.fn() handles directly (fully typed with .mockResolvedValue
  // etc.); the store objects are thin casts over them.
  const m = {
    setConnected: vi.fn(),
    deleteConnector: vi.fn(),
    listConnectors: vi.fn().mockResolvedValue([]),
    getAuthCredentials: vi.fn().mockResolvedValue(null),
    listForUser: vi.fn().mockResolvedValue([]),
    listByUser: vi.fn().mockResolvedValue([]),
    listByWorkspace: vi.fn().mockResolvedValue([]),
    createUserInstance: vi.fn().mockResolvedValue(instance()),
    update: vi.fn().mockResolvedValue(instance()),
    deleteInstance: vi.fn().mockResolvedValue(true),
    getConfig: vi.fn().mockResolvedValue({}),
    setConfig: vi.fn().mockResolvedValue(undefined),
  }
  const connectorStore = {
    setConnected: m.setConnected,
    delete: m.deleteConnector,
    list: m.listConnectors,
    getAuthCredentials: m.getAuthCredentials,
    getConfig: m.getConfig,
    setConfig: m.setConfig,
  } as unknown as ConnectorStore
  const connectorInstanceStore = {
    listForUser: m.listForUser,
    listByUser: m.listByUser,
    listByWorkspace: m.listByWorkspace,
    createUserInstance: m.createUserInstance,
    update: m.update,
    delete: m.deleteInstance,
  } as unknown as ConnectorInstanceStore

  const app = express()
  app.use(express.json())
  if (userId) {
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
  }
  app.use('/api/connectors', connectorRoutes({ connectorStore, connectorInstanceStore }))
  return { app, ...m }
}

describe('[COMP:api/connectors-route] /api/connectors', () => {
  beforeEach(() => vi.clearAllMocks())

  // The desktop exchange-and-store tests stub global fetch + read OAuth client
  // secrets from the env; snapshot/restore both so they can't leak across tests.
  const OAUTH_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET']
  const savedEnv: Record<string, string | undefined> = {}
  beforeEach(() => { for (const k of OAUTH_ENV_KEYS) savedEnv[k] = process.env[k] })
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const k of OAUTH_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  // Connector-health governance route (migration 294).
  it('[COMP:integrations/connector-health] GET /workspace/:id lists workspace connectors with health for a member', async () => {
    const { app, listByWorkspace } = makeApp('u1')
    const WS = '11111111-1111-1111-1111-111111111111'
    listByWorkspace.mockResolvedValue([
      instance({ provider: 'github', label: 'Use Brian', connected: true, healthStatus: 'auth_failed', lastError: '401 Bad credentials' }),
      instance({ provider: 'slack', label: 'DeltaDeFi', connected: true, healthStatus: 'ok' }),
    ])
    const res = await request(app).get(`/api/connectors/workspace/${WS}`)
    expect(res.status).toBe(200)
    expect(listByWorkspace).toHaveBeenCalledWith('u1', WS)
    const gh = res.body.connectors.find((c: { provider: string }) => c.provider === 'github')
    expect(gh.healthStatus).toBe('auth_failed')
    expect(gh.label).toBe('Use Brian')
  })

  it('[COMP:integrations/connector-health] GET /workspace/:id rejects a non-uuid workspace id', async () => {
    const { app } = makeApp('u1')
    const res = await request(app).get('/api/connectors/workspace/not-a-uuid')
    expect(res.status).toBe(400)
  })

  it('401 without auth', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/connectors')
    expect(res.status).toBe(401)
  })

  it('GET / merges built-in placeholders with the caller instances', async () => {
    const { app, listForUser } = makeApp('u1')
    listForUser.mockResolvedValue([
      instance({ provider: 'gcal', label: 'Work cal', connectedEmail: 'a@b.com' }),
    ])
    const res = await request(app).get('/api/connectors')
    expect(res.status).toBe(200)
    const rows = res.body.connectors as Array<Record<string, unknown>>

    // The connected gcal instance is a real row (has a connectorInstanceId).
    const gcal = rows.find((r) => r.id === 'gcal')
    expect(gcal).toMatchObject({
      connectorInstanceId: IID,
      label: 'Work cal',
      connected: true,
      connectedEmail: 'a@b.com',
    })

    // github has no instance → it appears as a never-connected placeholder so
    // the page's "available" group is not empty on a fresh account.
    const github = rows.find((r) => r.id === 'github')
    expect(github).toMatchObject({ isPlaceholder: true, connected: false })
    expect(github?.connectorInstanceId).toBeUndefined()
  })

  it('GET /directory lists the official catalog with added/connected flags', async () => {
    const { app, listForUser } = makeApp('u1')
    listForUser.mockResolvedValue([instance({ provider: 'github', connected: true })])
    const res = await request(app).get('/api/connectors/directory')
    expect(res.status).toBe(200)
    const dir = res.body.directory as Array<Record<string, unknown>>
    expect(dir.find((d) => d.id === 'github')).toMatchObject({ added: true, connected: true })
    expect(dir.find((d) => d.id === 'notion')).toMatchObject({ added: false, connected: false })
    // Multi-account: every credentialed connector is addable — the Google
    // family included — EXCEPT single_instance registry entries (gcs binds a
    // workspace bucket, not an account).
    expect(dir.find((d) => d.id === 'gmail')).toMatchObject({ addable: true })
    expect(dir.find((d) => d.id === 'gcs')).toMatchObject({ addable: false })
  })

  it('POST /directory/:id/add creates a disconnected instance when none exists', async () => {
    const { app, listByUser, createUserInstance } = makeApp('u1')
    listByUser.mockResolvedValue([])
    const res = await request(app).post('/api/connectors/directory/notion/add')
    expect(res.status).toBe(200)
    expect(createUserInstance).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'notion', connected: false }),
    )
  })

  it('POST /directory/:id/add is idempotent and 404s an unknown connector', async () => {
    const { app, listByUser, createUserInstance } = makeApp('u1')
    listByUser.mockResolvedValue([instance({ provider: 'github' })])
    const ok = await request(app).post('/api/connectors/directory/github/add')
    expect(ok.status).toBe(200)
    expect(createUserInstance).not.toHaveBeenCalled()

    const unknown = await request(app).post('/api/connectors/directory/bogus/add')
    expect(unknown.status).toBe(404)
  })

  it('GET /:provider/tools returns the built-in tool catalog (was "No tools found")', async () => {
    const { app } = makeApp('u1')
    const res = await request(app).get('/api/connectors/github/tools')
    expect(res.status).toBe(200)
    expect(res.body.serverName).toBe('GitHub')
    expect(Array.isArray(res.body.tools)).toBe(true)
    expect(res.body.tools.length).toBeGreaterThan(0)
    expect(res.body.tools[0]).toMatchObject({
      name: expect.any(String),
      classification: expect.any(String),
      policy: expect.stringMatching(/allow|ask|block/),
    })
  })

  it('GET /:provider/tools live-discovers a custom connector\'s tools', async () => {
    // A custom connector (provider = UUID, not in OFFICIAL_CONNECTOR_TOOLS) is
    // discovered live, so the Tools tab matches the settings-tab probe instead
    // of "No tools found".
    const { app, listConnectors, getAuthCredentials } = makeApp('u1')
    const CX = 'cx-uuid-1'
    listConnectors.mockResolvedValue([
      { connectorId: CX, name: 'My MCP', custom: true, url: 'https://mcp.example/sse', connected: true, credentialsType: 'bearer' },
    ])
    getAuthCredentials.mockResolvedValue({ type: 'bearer', token: 't1' })
    mockDiscover.mockResolvedValue({
      name: 'My MCP',
      url: 'https://mcp.example/sse',
      tools: [{ name: 'alpha', description: 'A' }, { name: 'beta', description: 'B' }],
    })
    const res = await request(app).get(`/api/connectors/${CX}/tools`)
    expect(res.status).toBe(200)
    expect(res.body.serverName).toBe('My MCP')
    expect(res.body.tools).toHaveLength(2)
    expect(res.body.tools[0]).toMatchObject({
      name: 'alpha',
      classification: expect.any(String),
      policy: expect.stringMatching(/allow|ask|block/),
    })
    // Discovery carries the connector's configured auth headers.
    expect(mockDiscover).toHaveBeenCalledWith('https://mcp.example/sse', 'My MCP', { Authorization: 'Bearer t1' })
  })

  it('GET /:provider/tools 500s when custom discovery fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, listConnectors } = makeApp('u1')
    const CX = 'cx-uuid-2'
    listConnectors.mockResolvedValue([
      { connectorId: CX, name: 'Broken', custom: true, url: 'https://x', connected: false, credentialsType: 'none' },
    ])
    mockDiscover.mockRejectedValue(new Error('unreachable'))
    const res = await request(app).get(`/api/connectors/${CX}/tools`)
    expect(res.status).toBe(500)
  })

  it('GET /:provider/tools is empty for a provider with no catalog entry', async () => {
    // A slug absent from OFFICIAL_CONNECTOR_TOOLS (e.g. a custom connector) has
    // no built-in tool set. Note official connectors — including `files` — DO
    // carry catalogs, so this must use a genuinely unlisted provider.
    const { app } = makeApp('u1')
    const res = await request(app).get('/api/connectors/no-such-connector/tools')
    expect(res.status).toBe(200)
    expect(res.body.tools).toEqual([])
  })

  it('GET + PATCH /:provider/config round-trips through the store', async () => {
    const { app, getConfig, setConfig } = makeApp('u1')
    getConfig.mockResolvedValue({ sendUpdates: 'all' })
    const get = await request(app).get('/api/connectors/gcal/config')
    expect(get.status).toBe(200)
    expect(get.body.config).toEqual({ sendUpdates: 'all' })

    const patch = await request(app).patch('/api/connectors/gcal/config').send({ sendUpdates: 'none' })
    expect(patch.status).toBe(200)
    expect(setConfig).toHaveBeenCalledWith('u1', 'gcal', { sendUpdates: 'none' })
  })

  it('POST /instances/:id/connect flips a specific instance online', async () => {
    const { app, update } = makeApp('u1')
    update.mockResolvedValue(instance({ connected: true }))
    const res = await request(app).post(`/api/connectors/instances/${IID}/connect`)
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith('u1', IID, { connected: true })
  })

  it('store-credentials rejects an unsupported provider', async () => {
    const { app, createUserInstance } = makeApp('u1')
    const res = await request(app).post('/api/connectors/bogus/store-credentials').send({ pat: 'x' })
    expect(res.status).toBe(400)
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('store-credentials rejects a credential-less connector (files)', async () => {
    const { app } = makeApp('u1')
    const res = await request(app).post('/api/connectors/files/store-credentials').send({ token: 'x' })
    expect(res.status).toBe(400)
  })

  it('store-credentials 400 when no secret provided', async () => {
    const { app } = makeApp('u1')
    const res = await request(app).post('/api/connectors/github/store-credentials').send({ email: 'a@b.com' })
    expect(res.status).toBe(400)
  })

  it('store-credentials primary path creates an instance when none exists', async () => {
    const { app, createUserInstance } = makeApp('u1')
    const res = await request(app).post('/api/connectors/github/store-credentials').send({ pat: 'ghp_abc' })
    expect(res.status).toBe(200)
    expect(createUserInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        provider: 'github',
        connected: true,
        credentials: { type: 'oauth', client_id: '', client_secret: 'ghp_abc' },
      }),
    )
  })

  it('store-credentials primary path updates the existing instance', async () => {
    const { app, listByUser, update, createUserInstance } = makeApp('u1')
    listByUser.mockResolvedValue([instance({ provider: 'gcal' })])
    const res = await request(app)
      .post('/api/connectors/gcal/store-credentials')
      .send({ refreshToken: 'rt', email: 'a@b.com' })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(
      'u1',
      IID,
      expect.objectContaining({
        connected: true,
        connectedEmail: 'a@b.com',
        credentials: { type: 'oauth', client_id: '', client_secret: 'rt' },
      }),
    )
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('store-credentials createNew always creates a fresh instance', async () => {
    const { app, listByUser, createUserInstance, update } = makeApp('u1')
    listByUser.mockResolvedValue([instance({ provider: 'github' })])
    const res = await request(app)
      .post('/api/connectors/github/store-credentials')
      .send({ pat: 'ghp_2', createNew: true, label: 'Second acct' })
    expect(res.status).toBe(200)
    expect(createUserInstance).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Second acct' }),
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('store-credentials with instanceId 404s when the instance is missing', async () => {
    const { app, update } = makeApp('u1')
    update.mockResolvedValue(null)
    const res = await request(app)
      .post('/api/connectors/github/store-credentials')
      .send({ pat: 'x', instanceId: IID })
    expect(res.status).toBe(404)
  })

  it('store-credentials rejects a malformed instanceId', async () => {
    const { app } = makeApp('u1')
    const res = await request(app)
      .post('/api/connectors/github/store-credentials')
      .send({ pat: 'x', instanceId: 'not-a-uuid' })
    expect(res.status).toBe(400)
  })

  it('store-credentials returns 503 when the encryption key is unset', async () => {
    const { app, createUserInstance } = makeApp('u1')
    createUserInstance.mockRejectedValue(
      new Error('Cannot store connector credentials: CHANNEL_CREDENTIAL_KEY is not configured'),
    )
    const res = await request(app).post('/api/connectors/github/store-credentials').send({ pat: 'x' })
    expect(res.status).toBe(503)
  })

  // ── POST /:provider/exchange-and-store — desktop OAuth loopback path ──
  // Spec: docs/plans/desktop-connector-oauth-return.md. Google/Notion wired;
  // Fathom intentionally has no exchanger (its store path is unwired).

  const G_REDIRECT = 'https://app.usebrian.ai/api/auth/callback/google-connector'

  /** Stub global fetch with a queued list of responses (token, then userinfo). */
  function stubFetch(responses: Array<{ ok: boolean; status?: number; json?: unknown }>) {
    let i = 0
    const fn = vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.json ?? {} } as unknown as Response
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('exchange-and-store 401 without auth', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/gdrive/exchange-and-store').send({ code: 'c', redirectUri: G_REDIRECT })
    expect(res.status).toBe(401)
  })

  it('exchange-and-store rejects a provider with no desktop exchanger (github)', async () => {
    const { app } = makeApp('u1')
    const res = await request(app).post('/api/connectors/github/exchange-and-store').send({ code: 'c', redirectUri: G_REDIRECT })
    expect(res.status).toBe(400)
  })

  it('exchange-and-store 400 when code or redirectUri is missing', async () => {
    const { app } = makeApp('u1')
    const res = await request(app).post('/api/connectors/gdrive/exchange-and-store').send({ code: 'c' })
    expect(res.status).toBe(400)
  })

  it('exchange-and-store Google exchanges the code and stores the refresh token', async () => {
    process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec'
    const { app, createUserInstance } = makeApp('u1')
    stubFetch([
      { ok: true, json: { access_token: 'at', refresh_token: 'rt-123' } }, // token
      { ok: true, json: { email: 'user@example.com' } },                    // userinfo
    ])
    const res = await request(app).post('/api/connectors/gdrive/exchange-and-store').send({ code: 'code-abc', redirectUri: G_REDIRECT })
    expect(res.status).toBe(200)
    expect(createUserInstance).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'gdrive', connected: true, connectedEmail: 'user@example.com',
      credentials: { type: 'oauth', client_id: '', client_secret: 'rt-123' },
    }))
  })

  it('exchange-and-store Google 502s when no refresh_token comes back', async () => {
    process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec'
    const { app, createUserInstance } = makeApp('u1')
    stubFetch([{ ok: true, json: { access_token: 'at' } }]) // no refresh_token
    const res = await request(app).post('/api/connectors/gcal/exchange-and-store').send({ code: 'c', redirectUri: G_REDIRECT })
    expect(res.status).toBe(502)
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('exchange-and-store Google 503s when the client secret is unset', async () => {
    delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET
    const { app } = makeApp('u1')
    const res = await request(app).post('/api/connectors/gdrive/exchange-and-store').send({ code: 'c', redirectUri: G_REDIRECT })
    expect(res.status).toBe(503)
  })

  it('exchange-and-store Notion stores the access token, workspace name as the createNew label', async () => {
    process.env.NOTION_CLIENT_ID = 'nid'; process.env.NOTION_CLIENT_SECRET = 'nsec'
    const { app, createUserInstance } = makeApp('u1')
    stubFetch([{ ok: true, json: { access_token: 'notion-at', workspace_name: 'Acme HQ' } }])
    const res = await request(app)
      .post('/api/connectors/notion/exchange-and-store')
      .send({ code: 'c', redirectUri: 'https://app.usebrian.ai/api/auth/callback/notion', createNew: true })
    expect(res.status).toBe(200)
    expect(createUserInstance).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'notion', label: 'Acme HQ',
      credentials: { type: 'oauth', client_id: '', client_secret: 'notion-at' },
    }))
  })

  it('exchange-and-store reconnect (instanceId) re-points the existing instance', async () => {
    process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec'
    const { app, update } = makeApp('u1')
    stubFetch([
      { ok: true, json: { access_token: 'at', refresh_token: 'rt-r' } },
      { ok: true, json: { email: 'x@example.com' } },
    ])
    const res = await request(app).post('/api/connectors/gcal/exchange-and-store').send({ code: 'c', redirectUri: G_REDIRECT, instanceId: IID })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith('u1', IID, expect.objectContaining({
      credentials: { type: 'oauth', client_id: '', client_secret: 'rt-r' },
    }))
  })

  it('disconnect flips the primary instance and 404s when absent', async () => {
    const { app, setConnected } = makeApp('u1')
    setConnected.mockResolvedValueOnce(instance({ connected: false }))
    const ok = await request(app).post('/api/connectors/github/disconnect')
    expect(ok.status).toBe(200)
    expect(setConnected).toHaveBeenCalledWith('u1', 'github', false)

    setConnected.mockResolvedValueOnce(null)
    const missing = await request(app).post('/api/connectors/github/disconnect')
    expect(missing.status).toBe(404)
  })

  it('PATCH /instances/:id renames; rejects blank label and bad id', async () => {
    const { app, update } = makeApp('u1')
    update.mockResolvedValue(instance({ label: 'Renamed' }))
    const ok = await request(app).patch(`/api/connectors/instances/${IID}`).send({ label: 'Renamed' })
    expect(ok.status).toBe(200)
    expect(ok.body.label).toBe('Renamed')

    const blank = await request(app).patch(`/api/connectors/instances/${IID}`).send({ label: '  ' })
    expect(blank.status).toBe(400)

    const badId = await request(app).patch('/api/connectors/instances/nope').send({ label: 'x' })
    expect(badId.status).toBe(400)
  })

  it('DELETE /instances/:id deletes a specific instance', async () => {
    const { app, deleteInstance } = makeApp('u1')
    const res = await request(app).delete(`/api/connectors/instances/${IID}`)
    expect(res.status).toBe(200)
    expect(deleteInstance).toHaveBeenCalledWith('u1', IID)
  })

  it('DELETE /:provider deletes the primary instance and 404s when absent', async () => {
    const { app, deleteConnector } = makeApp('u1')
    deleteConnector.mockResolvedValueOnce(true)
    const ok = await request(app).delete('/api/connectors/github')
    expect(ok.status).toBe(200)

    deleteConnector.mockResolvedValueOnce(false)
    const missing = await request(app).delete('/api/connectors/notion')
    expect(missing.status).toBe(404)
  })
})
