/**
 * Workspace-owned Entra app credentials + the server-side code exchange for
 * the `msgraph` connector, OPEN edition.
 *
 * The hosted product cannot use deployment config for this connector: the
 * person who registers the Entra app is a customer admin who has no access to
 * the environment. So a workspace registers its own app, it is resolved ahead
 * of config, and the exchange runs in the API because the secret is theirs.
 * See docs/architecture/integrations/msgraph.md → "Auth". The closed edition
 * mirrors these routes in packages/api-platform/src/routes/connectors.ts
 * (connector-route-parity).
 *
 * Component tag: [COMP:api/msgraph-app-credentials].
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import { unpackMsGraphAppCredentials, unpackMsGraphTokens } from '../../msgraph/token.js'
import { ConnectorAppCredentialAuthError, type ConnectorAppCredentialStore } from '../../db/connector-app-credential-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'

const APP_PATH = '/api/connectors/msgraph/app-credentials'
const CALLBACK_PATH = '/api/connectors/msgraph/oauth-callback'
const WS = '22222222-2222-2222-2222-222222222222'
const IID = '11111111-1111-1111-1111-111111111111'
const REDIRECT = 'https://app.usebrian.ai/api/auth/callback/msgraph'

/** An `id_token` carrying a tenant and an address, unsigned (never verified). */
function idToken(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
  return `${seg({ alg: 'RS256' })}.${seg(claims)}.sig`
}

function makeApp(over: {
  workspaceApp?: { clientId: string; clientSecret: string; tenantId?: string } | null
  setImpl?: ConnectorAppCredentialStore['set']
  withStore?: boolean
} = {}) {
  const getSystem = vi.fn().mockResolvedValue(over.workspaceApp ?? null)
  const get = vi.fn().mockResolvedValue(
    over.workspaceApp
      ? {
          provider: 'msgraph', workspaceId: WS, clientId: over.workspaceApp.clientId,
          tenantId: over.workspaceApp.tenantId ?? null, hasSecret: true, updatedAt: new Date(0),
        }
      : null,
  )
  const set = over.setImpl ?? vi.fn().mockResolvedValue({
    provider: 'msgraph', workspaceId: WS, clientId: 'ws-client', tenantId: null,
    hasSecret: true, updatedAt: new Date(0),
  })
  const remove = vi.fn().mockResolvedValue(true)
  const createUserInstance = vi.fn().mockResolvedValue({ id: IID })
  const update = vi.fn().mockResolvedValue({ id: IID })

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = 'u1'; next() })
  app.use('/api/connectors', connectorRoutes({
    connectorStore: { getConfig: vi.fn().mockResolvedValue({}), setConfig: vi.fn(), upsert: vi.fn() } as unknown as ConnectorStore,
    connectorInstanceStore: {
      listForUser: vi.fn().mockResolvedValue([]),
      listByUser: vi.fn().mockResolvedValue([]),
      createUserInstance,
      update,
      setConfig: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectorInstanceStore,
    ...(over.withStore === false
      ? {}
      : { connectorAppCredentialStore: { get, getSystem, set, remove } as unknown as ConnectorAppCredentialStore }),
  }))
  return { app, get, getSystem, set, remove, createUserInstance, update }
}

/** Stub the Entra token endpoint. `tokenEndpointCall` uses global fetch here. */
function stubTokenEndpoint(body: Record<string, unknown>, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  delete process.env.MSGRAPH_CLIENT_ID
  delete process.env.MSGRAPH_CLIENT_SECRET
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MSGRAPH_CLIENT_ID
  delete process.env.MSGRAPH_CLIENT_SECRET
})

describe('[COMP:api/msgraph-app-credentials] status', () => {
  it('reports the workspace registration ahead of deployment config', async () => {
    process.env.MSGRAPH_CLIENT_ID = 'env-client'
    process.env.MSGRAPH_CLIENT_SECRET = 'env-secret'
    const { app } = makeApp({ workspaceApp: { clientId: 'ws-client', clientSecret: 'ws-secret', tenantId: 'tid-1' } })

    const res = await request(app).get(`${APP_PATH}?workspaceId=${WS}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      configured: true, source: 'workspace', clientId: 'ws-client',
      tenantId: 'tid-1', workspaceOwned: true,
    })
    // The public half only. A secret must never be readable back out.
    expect(JSON.stringify(res.body)).not.toContain('ws-secret')
  })

  it('falls back to deployment config, marked as such', async () => {
    process.env.MSGRAPH_CLIENT_ID = 'env-client'
    process.env.MSGRAPH_CLIENT_SECRET = 'env-secret'
    const { app } = makeApp({ workspaceApp: null })

    const res = await request(app).get(`${APP_PATH}?workspaceId=${WS}`)

    expect(res.body).toMatchObject({
      configured: true, source: 'deployment', clientId: 'env-client', workspaceOwned: false,
    })
  })

  /**
   * The case that drove this feature: nothing configured anywhere. It must be
   * reported honestly so the page opens the registration form instead of
   * sending the user to an Entra error page about a missing client_id.
   */
  it('reports unconfigured when neither source has an app', async () => {
    const { app } = makeApp({ workspaceApp: null })
    const res = await request(app).get(`${APP_PATH}?workspaceId=${WS}`)
    expect(res.body).toMatchObject({ configured: false, source: null, clientId: null })
  })

  it('404s for a provider that does not support workspace app credentials', async () => {
    const { app } = makeApp()
    expect((await request(app).get(`/api/connectors/notion/app-credentials?workspaceId=${WS}`)).status).toBe(404)
    expect((await request(app).put('/api/connectors/gcal/app-credentials').send({
      workspaceId: WS, clientId: 'a', clientSecret: 'b',
    })).status).toBe(404)
  })
})

describe('[COMP:api/msgraph-app-credentials] registration writes', () => {
  it('stores a valid pair', async () => {
    const { app, set } = makeApp()
    const res = await request(app).put(APP_PATH).send({
      workspaceId: WS, clientId: 'ws-client', clientSecret: 'ws-secret', tenantId: 'tid-1',
    })
    expect(res.status).toBe(200)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      actingUserId: 'u1', workspaceId: WS, provider: 'msgraph',
      clientId: 'ws-client', clientSecret: 'ws-secret', tenantId: 'tid-1',
    }))
  })

  it('maps the store authority error to 403 rather than a 500', async () => {
    const { app } = makeApp({
      setImpl: vi.fn().mockRejectedValue(new ConnectorAppCredentialAuthError('not_admin')) as never,
    })
    const res = await request(app).put(APP_PATH).send({
      workspaceId: WS, clientId: 'a', clientSecret: 'b',
    })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('not_admin')
  })

  /**
   * Both values are interpolated into a URL and a form body, so a newline is a
   * header/URL-injection primitive, not a formatting nuisance.
   */
  it('rejects CR/LF, oversize and missing halves', async () => {
    const { app, set } = makeApp()
    for (const body of [
      { workspaceId: WS, clientId: 'a\nb', clientSecret: 'x' },
      { workspaceId: WS, clientId: 'a', clientSecret: 'x\r\ny' },
      { workspaceId: WS, clientId: 'a'.repeat(2049), clientSecret: 'x' },
      { workspaceId: WS, clientId: '   ', clientSecret: 'x' },
      { workspaceId: WS, clientId: 'a' },
    ]) {
      const res = await request(app).put(APP_PATH).send(body)
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('rejects a tenant that would rewrite the token URL path', async () => {
    const { app } = makeApp()
    for (const tenantId of ['../evil', 'a/b', 'has space', 'x'.repeat(257)]) {
      const res = await request(app).put(APP_PATH).send({
        workspaceId: WS, clientId: 'a', clientSecret: 'b', tenantId,
      })
      expect(res.status, tenantId).toBe(400)
    }
  })

  it('requires a workspace id on write', async () => {
    const { app } = makeApp()
    expect((await request(app).put(APP_PATH).send({ clientId: 'a', clientSecret: 'b' })).status).toBe(400)
    expect((await request(app).delete(APP_PATH)).status).toBe(400)
  })

  it('removes the registration', async () => {
    const { app, remove } = makeApp()
    const res = await request(app).delete(`${APP_PATH}?workspaceId=${WS}`)
    expect(res.status).toBe(200)
    expect(remove).toHaveBeenCalledWith('u1', WS, 'msgraph')
  })
})

describe('[COMP:api/msgraph-app-credentials] code exchange', () => {
  const tokenBody = {
    access_token: 'at', refresh_token: 'rt', expires_in: 3600,
    id_token: idToken({ tid: 'tid-1', preferred_username: 'ada@contoso.example' }),
  }

  it('exchanges with the workspace app and pins the pair into the envelope', async () => {
    const fetchMock = stubTokenEndpoint(tokenBody)
    const { app, createUserInstance } = makeApp({
      workspaceApp: { clientId: 'ws-client', clientSecret: 'ws-secret', tenantId: 'tid-1' },
    })

    const res = await request(app).post(CALLBACK_PATH).send({ code: 'c', redirectUri: REDIRECT, workspaceId: WS })

    expect(res.status).toBe(200)
    // A single-tenant workspace app must be exchanged at its own authority;
    // `organizations` would not issue for it.
    expect(fetchMock.mock.calls[0]![0]).toBe('https://login.microsoftonline.com/tid-1/oauth2/v2.0/token')
    const form = String((fetchMock.mock.calls[0]![1] as { body: URLSearchParams }).body)
    expect(form).toContain('client_id=ws-client')
    expect(form).toContain('client_secret=ws-secret')

    const blob = (createUserInstance.mock.calls[0]![0] as { credentials: { client_secret: string } }).credentials.client_secret
    // Only the app that minted a refresh token can rotate it, and the refresh
    // path has no workspace id — so the pair must ride in the envelope.
    expect(unpackMsGraphAppCredentials(blob)).toEqual({ clientId: 'ws-client', clientSecret: 'ws-secret' })
    expect(unpackMsGraphTokens(blob)).toMatchObject({ accessToken: 'at', refreshToken: 'rt', tenantId: 'tid-1' })
  })

  it('does NOT pin a deployment app into the envelope', async () => {
    process.env.MSGRAPH_CLIENT_ID = 'env-client'
    process.env.MSGRAPH_CLIENT_SECRET = 'env-secret'
    stubTokenEndpoint(tokenBody)
    const { app, createUserInstance } = makeApp({ workspaceApp: null })

    await request(app).post(CALLBACK_PATH).send({ code: 'c', redirectUri: REDIRECT, workspaceId: WS })

    const blob = (createUserInstance.mock.calls[0]![0] as { credentials: { client_secret: string } }).credentials.client_secret
    // A deployment secret is re-resolvable from config at refresh time; copying
    // it would freeze a rotated secret into every grant issued before rotation.
    expect(unpackMsGraphAppCredentials(blob)).toBeNull()
  })

  it('labels the instance from the id_token address without a Graph round trip', async () => {
    stubTokenEndpoint(tokenBody)
    const { app, createUserInstance } = makeApp({ workspaceApp: { clientId: 'c', clientSecret: 's' } })

    await request(app).post(CALLBACK_PATH).send({ code: 'c', redirectUri: REDIRECT, workspaceId: WS })

    expect(createUserInstance.mock.calls[0]![0]).toMatchObject({ connectedEmail: 'ada@contoso.example', connected: true })
  })

  it('400s with an actionable code when no app is registered anywhere', async () => {
    const fetchMock = stubTokenEndpoint(tokenBody)
    const { app } = makeApp({ workspaceApp: null })

    const res = await request(app).post(CALLBACK_PATH).send({ code: 'c', redirectUri: REDIRECT, workspaceId: WS })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('app_credentials_missing')
    // Nothing was sent to Microsoft — there was nothing to send it with.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('502s when Entra rejects the code', async () => {
    stubTokenEndpoint({ error: 'invalid_grant', error_description: 'code expired' }, false)
    const { app } = makeApp({ workspaceApp: { clientId: 'c', clientSecret: 's' } })

    const res = await request(app).post(CALLBACK_PATH).send({ code: 'c', redirectUri: REDIRECT, workspaceId: WS })
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('token_exchange_failed')
  })

  /**
   * Graph rotates the refresh token on every use, so a grant stored without
   * one works for an hour and then dies with no way back except reconnecting.
   * It must fail the connect, not record a terminal connection.
   */
  it('fails the connect when the grant carries no refresh token', async () => {
    stubTokenEndpoint({ access_token: 'at', expires_in: 3600 })
    const { app, createUserInstance } = makeApp({ workspaceApp: { clientId: 'c', clientSecret: 's' } })

    const res = await request(app).post(CALLBACK_PATH).send({ code: 'c', redirectUri: REDIRECT, workspaceId: WS })

    expect(res.status).toBe(502)
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('rejects a callback with no code or redirect uri', async () => {
    const { app } = makeApp({ workspaceApp: { clientId: 'c', clientSecret: 's' } })
    expect((await request(app).post(CALLBACK_PATH).send({ redirectUri: REDIRECT })).status).toBe(400)
    expect((await request(app).post(CALLBACK_PATH).send({ code: 'c' })).status).toBe(400)
  })

  it('re-points an existing instance on reconnect instead of minting a second one', async () => {
    stubTokenEndpoint(tokenBody)
    const { app, update, createUserInstance } = makeApp({ workspaceApp: { clientId: 'c', clientSecret: 's' } })

    const res = await request(app).post(CALLBACK_PATH).send({
      code: 'c', redirectUri: REDIRECT, workspaceId: WS, instanceId: IID,
    })

    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalled()
    expect(createUserInstance).not.toHaveBeenCalled()
  })
})
