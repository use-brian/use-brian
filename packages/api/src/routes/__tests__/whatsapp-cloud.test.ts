import { createHmac } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelIntegrationStore, WhatsAppCloudCredentials } from '../../db/channel-integrations.js'

vi.mock('../../db/channels-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/channels-store.js')>()),
  getChannelForWebhook: vi.fn(),
}))

import { getChannelForWebhook } from '../../db/channels-store.js'
import {
  dispatchWhatsAppCloudWorkflowEvent,
  whatsappCloudExternalConnectorToolsAllowed,
  whatsappCloudRoutes,
  whatsappCloudUserAllowed,
} from '../whatsapp-cloud.js'

const credentials: WhatsAppCloudCredentials = {
  provider: 'cloud_api', access_token: 'token', app_secret: 'app-secret', verify_token: 'verify-token',
  phone_number_id: 'phone-1', waba_id: 'waba-1', display_phone_number: '+15551234567', graph_api_version: 'v26.0',
}

function integrationStore(config: Record<string, unknown> = {}): ChannelIntegrationStore {
  return {
    getByChannelForWebhook: vi.fn().mockResolvedValue({
      id: 'int-1', channelId: 'chan-1', channelType: 'whatsapp', teamId: 'waba-1', teamName: 'Acme',
      botUserId: 'phone-1', botUsername: null, config, status: 'active', createdAt: new Date(),
      updatedAt: new Date(), lastEventAt: null, connectorInstanceId: null, credentials,
    }),
    touchLastEventAt: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelIntegrationStore
}

function app(
  store = integrationStore(),
  workflowEventDispatcher?: { dispatch: ReturnType<typeof vi.fn> },
) {
  const api = express()
  api.use(express.json({ verify(req, _res, buf) { (req as express.Request & { rawBody?: string }).rawBody = buf.toString() } }))
  api.use('/webhook/whatsapp', whatsappCloudRoutes({
    integrationStore: store,
    provider: {} as never, systemPrompt: '', tools: new Map(), memoryStore: {} as never,
    capabilityStore: {} as never,
    workflowEventDispatcher: workflowEventDispatcher as never,
  }))
  return api
}

describe('[COMP:api/whatsapp-cloud-route]', () => {
  it('fails closed when the caller is not explicitly allowlisted', () => {
    expect(whatsappCloudUserAllowed({}, '15551234567')).toBe(false)
    expect(whatsappCloudUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: [] }, '15551234567')).toBe(false)
    expect(whatsappCloudUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: ['15551234567'] }, '15551234567')).toBe(true)
  })

  it('enables connector tools for allowlisted external users', () => {
    expect(whatsappCloudExternalConnectorToolsAllowed({}, false)).toBe(false)
    expect(whatsappCloudExternalConnectorToolsAllowed({ userAccessMode: 'allow_all' }, false)).toBe(false)
    expect(whatsappCloudExternalConnectorToolsAllowed({ userAccessMode: 'allowlist' }, false)).toBe(true)
    expect(whatsappCloudExternalConnectorToolsAllowed({ userAccessMode: 'allowlist' }, true)).toBe(false)
  })

  it('dispatches authorized messages to the shared workflow event producer', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    await dispatchWhatsAppCloudWorkflowEvent({
      dispatcher: { dispatch } as never,
      workspaceId: 'ws-1',
      channelIntegrationId: 'int-1',
      config: { userAccessMode: 'allowlist', allowedUserIds: ['15551234567'] },
      incoming: {
        userId: '15551234567',
        channelId: '15551234567',
        messageId: 'wamid-1',
        text: 'Need help with my order',
        isGroupChat: false,
        timestamp: 1,
        raw: {
          phoneNumberId: 'phone-1',
          message: { type: 'text' },
        },
      },
    })

    expect(dispatch).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      source: { type: 'channel', channelIntegrationId: 'int-1', channel: 'whatsapp' },
      text: 'Need help with my order',
      actorId: '15551234567',
      channelId: '15551234567',
      mentions: [],
      isBot: false,
      payload: {
        text: 'Need help with my order',
        message_id: 'wamid-1',
        from: '15551234567',
        phone_number_id: 'phone-1',
        message_type: 'text',
        media_type: null,
      },
    })
  })

  it('does not dispatch workflow events for denied senders', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    await dispatchWhatsAppCloudWorkflowEvent({
      dispatcher: { dispatch } as never,
      workspaceId: 'ws-1',
      channelIntegrationId: 'int-1',
      config: { userAccessMode: 'allowlist', allowedUserIds: [] },
      incoming: {
        userId: '15551234567',
        channelId: '15551234567',
        messageId: 'wamid-1',
        text: 'Hello',
        isGroupChat: false,
        timestamp: 1,
        raw: null,
      },
    })

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('routes a signed authorized webhook to workflows independently of chat', async () => {
    vi.mocked(getChannelForWebhook).mockResolvedValue({
      id: 'chan-1',
      workspaceId: 'ws-1',
      channelType: 'whatsapp',
      clearance: 'internal',
      enabledCapabilities: [],
      status: 'active',
      displayName: 'Support',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) }
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'phone-1' },
            messages: [{
              id: 'wamid-route-1',
              from: '15551234567',
              timestamp: '1',
              type: 'text',
              text: { body: 'Start the support workflow' },
            }],
          },
        }],
      }],
    })
    const signature = `sha256=${createHmac('sha256', credentials.app_secret).update(body).digest('hex')}`
    const store = integrationStore({
      userAccessMode: 'allowlist',
      allowedUserIds: ['15551234567'],
    })

    const res = await request(app(store, dispatcher))
      .post('/webhook/whatsapp/chan-1')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(body)

    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(dispatcher.dispatch).toHaveBeenCalledTimes(1))
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      source: { type: 'channel', channelIntegrationId: 'int-1', channel: 'whatsapp' },
      text: 'Start the support workflow',
      actorId: '15551234567',
    }))
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
