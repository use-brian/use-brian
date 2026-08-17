import { createHmac } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelIntegrationStore, WhatsAppCloudCredentials } from '../../db/channel-integrations.js'
import {
  whatsappCloudGuestConnectorToolsAllowed,
  whatsappCloudRoutes,
  whatsappCloudUserAllowed,
} from '../whatsapp-cloud.js'

const credentials: WhatsAppCloudCredentials = {
  provider: 'cloud_api', access_token: 'token', app_secret: 'app-secret', verify_token: 'verify-token',
  phone_number_id: 'phone-1', waba_id: 'waba-1', display_phone_number: '+15551234567', graph_api_version: 'v26.0',
}

function integrationStore(): ChannelIntegrationStore {
  return {
    getByChannelForWebhook: vi.fn().mockResolvedValue({
      id: 'int-1', channelId: 'chan-1', channelType: 'whatsapp', teamId: 'waba-1', teamName: 'Acme',
      botUserId: 'phone-1', botUsername: null, config: {}, status: 'active', createdAt: new Date(),
      updatedAt: new Date(), lastEventAt: null, connectorInstanceId: null, credentials,
    }),
    touchLastEventAt: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelIntegrationStore
}

function app(store = integrationStore()) {
  const api = express()
  api.use(express.json({ verify(req, _res, buf) { (req as express.Request & { rawBody?: string }).rawBody = buf.toString() } }))
  api.use('/webhook/whatsapp', whatsappCloudRoutes({
    integrationStore: store,
    provider: {} as never, systemPrompt: '', tools: new Map(), memoryStore: {} as never,
    capabilityStore: {} as never,
  }))
  return api
}

describe('[COMP:api/whatsapp-cloud-route]', () => {
  it('fails closed when the caller is not explicitly allowlisted', () => {
    expect(whatsappCloudUserAllowed({}, '15551234567')).toBe(false)
    expect(whatsappCloudUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: [] }, '15551234567')).toBe(false)
    expect(whatsappCloudUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: ['15551234567'] }, '15551234567')).toBe(true)
  })

  it('enables connector tools for external guests only with an explicit opt-in', () => {
    expect(whatsappCloudGuestConnectorToolsAllowed({}, false)).toBe(false)
    expect(whatsappCloudGuestConnectorToolsAllowed({ userAccessMode: 'allow_all', allowGuestConnectorTools: true }, false)).toBe(false)
    expect(whatsappCloudGuestConnectorToolsAllowed({ userAccessMode: 'allowlist', allowGuestConnectorTools: true }, false)).toBe(true)
    expect(whatsappCloudGuestConnectorToolsAllowed({ userAccessMode: 'allowlist', allowGuestConnectorTools: true }, true)).toBe(false)
  })
  it('answers Meta subscription verification with the challenge', async () => {
    const res = await request(app()).get('/webhook/whatsapp/chan-1').query({
      'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token', 'hub.challenge': '12345',
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('12345')
  })

  it('rejects an invalid verify token', async () => {
    const res = await request(app()).get('/webhook/whatsapp/chan-1').query({
      'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345',
    })
    expect(res.status).toBe(403)
  })

  it('rejects webhook bodies without a valid Meta signature', async () => {
    const res = await request(app()).post('/webhook/whatsapp/chan-1').send({ object: 'whatsapp_business_account' })
    expect(res.status).toBe(401)
  })

  it('acknowledges signed status-only webhook updates', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [] } }] }] })
    const signature = `sha256=${createHmac('sha256', credentials.app_secret).update(body).digest('hex')}`
    const res = await request(app())
      .post('/webhook/whatsapp/chan-1')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(body)
    expect(res.status).toBe(200)
  })
})
