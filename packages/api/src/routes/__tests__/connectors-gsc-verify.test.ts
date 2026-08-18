import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { generateKeyPairSync } from 'node:crypto'
import { connectorRoutes } from '../connectors.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { SearchConsoleConnectorError, unpackSearchConsoleCredentials } from '../../gsc/client.js'

const PATH = '/api/connectors/gsc/store-credentials'
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const CLIENT_EMAIL = 'sa@example.iam.gserviceaccount.com'
const KEY_JSON = JSON.stringify({ type: 'service_account', client_email: CLIENT_EMAIL, private_key: PEM, project_id: 'example' })
const SITES = [
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' },
  { siteUrl: 'https://shop.example/', permissionLevel: 'siteOwner' },
]

function makeApp(verify: NonNullable<Parameters<typeof connectorRoutes>[0]['gscVerifyConnection']>) {
  const createUserInstance = vi.fn().mockResolvedValue({ id: 'gsc-instance' })
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = 'user-1'; next() })
  app.use('/api/connectors', connectorRoutes({
    connectorStore: { getConfig: vi.fn(), setConfig: vi.fn() } as unknown as ConnectorStore,
    connectorInstanceStore: {
      listForUser: vi.fn().mockResolvedValue([]),
      listByUser: vi.fn().mockResolvedValue([]),
      createUserInstance,
    } as unknown as ConnectorInstanceStore,
    gscVerifyConnection: verify,
  }))
  return { app, createUserInstance }
}

describe('[COMP:api/connectors-gsc] Search Console verification (open edition)', () => {
  it('rejects text that is not a service-account key before probing Google', async () => {
    const verify = vi.fn()
    const { app, createUserInstance } = makeApp(verify)
    const response = await request(app).post(PATH).send({ gscCredentials: { keyJson: '{"type":"authorized_user"}' } })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_key_json' })
    expect(verify).not.toHaveBeenCalled()
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('stores nothing and returns the code when Google rejects the key', async () => {
    const verify = vi.fn().mockRejectedValue(new SearchConsoleConnectorError('invalid_credentials', 'dead key', 401))
    const { app, createUserInstance } = makeApp(verify)
    const response = await request(app).post(PATH).send({ gscCredentials: { keyJson: KEY_JSON } })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_credentials' })
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('rejects a key that sees no properties, naming the service-account email to add', async () => {
    const verify = vi.fn().mockResolvedValue({ clientEmail: CLIENT_EMAIL, sites: [] })
    const { app, createUserInstance } = makeApp(verify)
    const response = await request(app).post(PATH).send({ gscCredentials: { keyJson: KEY_JSON } })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'no_properties', clientEmail: CLIENT_EMAIL })
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('rejects a default property the key cannot see, returning the ones it can', async () => {
    const verify = vi.fn().mockResolvedValue({ clientEmail: CLIENT_EMAIL, sites: SITES })
    const { app, createUserInstance } = makeApp(verify)
    const response = await request(app).post(PATH).send({ gscCredentials: { keyJson: KEY_JSON, defaultSite: 'sc-domain:other.example' } })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'unknown_property', sites: SITES })
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('verifies, packs the default property into the envelope, and echoes what it saw', async () => {
    const verify = vi.fn().mockResolvedValue({ clientEmail: CLIENT_EMAIL, sites: SITES })
    const { app, createUserInstance } = makeApp(verify)
    const response = await request(app).post(PATH).send({ gscCredentials: { keyJson: KEY_JSON, defaultSite: 'https://shop.example/' } })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true, connectorInstanceId: 'gsc-instance', clientEmail: CLIENT_EMAIL, defaultSite: 'https://shop.example/', sites: SITES,
    })
    expect(verify).toHaveBeenCalledWith({ clientEmail: CLIENT_EMAIL, privateKey: PEM, tokenUri: 'https://oauth2.googleapis.com/token' })
    const payload = createUserInstance.mock.calls[0]![0]
    expect(payload).toMatchObject({
      provider: 'gsc',
      label: 'https://shop.example/',
      connectedEmail: CLIENT_EMAIL,
      config: { clientEmail: CLIENT_EMAIL, defaultSite: 'https://shop.example/', siteCount: 2 },
      credentials: { type: 'oauth', client_id: 'gsc_service_account' },
    })
    expect(unpackSearchConsoleCredentials(payload.credentials.client_secret)).toEqual({
      clientEmail: CLIENT_EMAIL, privateKey: PEM, tokenUri: 'https://oauth2.googleapis.com/token', defaultSite: 'https://shop.example/',
    })
    // The private key never lands in non-secret config.
    expect(JSON.stringify(payload.config)).not.toContain('PRIVATE KEY')
  })

  it('auto-selects the default property when the key sees exactly one, and leaves it null for many', async () => {
    const one = makeApp(vi.fn().mockResolvedValue({ clientEmail: CLIENT_EMAIL, sites: [SITES[0]] }))
    const single = await request(one.app).post(PATH).send({ gscCredentials: { keyJson: KEY_JSON } })
    expect(single.status).toBe(200)
    expect(single.body.defaultSite).toBe('sc-domain:example.com')
    expect(one.createUserInstance.mock.calls[0]![0]).toMatchObject({ label: 'sc-domain:example.com', config: { defaultSite: 'sc-domain:example.com' } })

    const many = makeApp(vi.fn().mockResolvedValue({ clientEmail: CLIENT_EMAIL, sites: SITES }))
    const multi = await request(many.app).post(PATH).send({ gscCredentials: { keyJson: KEY_JSON } })
    expect(multi.status).toBe(200)
    expect(multi.body.defaultSite).toBeNull()
    const payload = many.createUserInstance.mock.calls[0]![0]
    expect(payload).toMatchObject({ label: CLIENT_EMAIL, config: { defaultSite: null, siteCount: 2 } })
    expect(unpackSearchConsoleCredentials(payload.credentials.client_secret)?.defaultSite).toBeNull()
  })
})
