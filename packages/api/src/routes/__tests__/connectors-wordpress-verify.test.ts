import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { WordPressConnectorError } from '../../wordpress/client.js'

const PATH = '/api/connectors/wordpress/store-credentials'
const TUPLE = {
  siteUrl: 'https://cms.example',
  username: 'site_editor',
  applicationPassword: 'abcd efgh ijkl mnop',
}

function makeApp(verify: NonNullable<Parameters<typeof connectorRoutes>[0]['wordpressVerifyConnection']>) {
  const createUserInstance = vi.fn().mockResolvedValue({ id: 'wordpress-instance' })
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
    wordpressVerifyConnection: verify,
  }))
  return { app, createUserInstance }
}

describe('[COMP:api/connectors-wordpress] WordPress verification (open edition)', () => {
  it('verifies the bridge before storing an encrypted Application Password tuple', async () => {
    const verify = vi.fn().mockResolvedValue({
      siteUrl: 'https://cms.example', name: 'Example Studio', bridgeVersion: '0.1.0',
    })
    const { app, createUserInstance } = makeApp(verify)
    const response = await request(app).post(PATH).send({ wordpressCredentials: TUPLE })

    expect(response.status).toBe(200)
    expect(verify).toHaveBeenCalledWith(TUPLE)
    const payload = createUserInstance.mock.calls[0]![0]
    expect(payload).toMatchObject({
      provider: 'wordpress',
      label: 'Example Studio',
      connectedEmail: 'https://cms.example',
      config: { siteUrl: 'https://cms.example', bridgeVersion: '0.1.0' },
      credentials: { type: 'oauth', client_id: 'wordpress_application_password' },
    })
    expect(JSON.parse(payload.credentials.client_secret)).toEqual(TUPLE)
    expect(JSON.stringify(payload.config)).not.toContain('applicationPassword')
  })

  it('stores nothing when the bridge is missing or credentials are rejected', async () => {
    const verify = vi.fn().mockRejectedValue(new WordPressConnectorError(
      'bridge_required', 'The Use Brian Bridge plugin is required', 404,
    ))
    const { app, createUserInstance } = makeApp(verify)
    const response = await request(app).post(PATH).send({ wordpressCredentials: TUPLE })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'bridge_required' })
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('rejects incomplete or insecure remote site URLs before probing', async () => {
    const verify = vi.fn()
    const { app, createUserInstance } = makeApp(verify)
    const response = await request(app).post(PATH).send({
      wordpressCredentials: { ...TUPLE, siteUrl: 'http://cms.example' },
    })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_site_url' })
    expect(verify).not.toHaveBeenCalled()
    expect(createUserInstance).not.toHaveBeenCalled()
  })
})
