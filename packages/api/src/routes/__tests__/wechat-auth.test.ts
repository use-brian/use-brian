/**
 * [COMP:api/wechat-inbound] — connector-secret guard + connector seam on
 * /internal/wechat.
 *
 * The router fronts GET /channels, which returns every active WeChat bot
 * token + base URL (the connector's restoreAll source) — so the guard must be
 * constant-time and fail closed: an empty configured secret matches nothing,
 * rather than comparing `undefined !== undefined` and waving an
 * unauthenticated caller through to the token list. Also covers the cursor
 * persistence endpoint (get_updates_buf merge into credentials).
 */

import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { wechatRoutes } from '../wechat.js'

function buildApp(connectorSecret: string) {
  const integrationStore = {
    listActiveWithCredentialsSystem: vi.fn(async () => [
      {
        channelId: 'chan-1',
        botUserId: 'bot123@im.bot',
        credentials: {
          bot_token: 'wechat-bot-token-1',
          base_url: 'https://shdx.ilink.example',
          ilink_bot_id: 'bot123@im.bot',
          get_updates_buf: 'cursor-abc',
        },
      },
    ]),
    mergeCredentialsSystem: vi.fn(async () => {}),
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/internal/wechat',
    wechatRoutes({
      connectorSecret,
      integrationStore,
      provider: {},
      systemPrompt: '',
      tools: new Map(),
      memoryStore: {},
      capabilityStore: {},
    } as never),
  )
  return { app, integrationStore }
}

describe('[COMP:api/wechat-inbound] connector-secret guard', () => {
  it('401s /channels without the secret header — no token rows leave', async () => {
    const { app, integrationStore } = buildApp('s3cret')
    const res = await request(app).get('/internal/wechat/channels')
    expect(res.status).toBe(401)
    expect(integrationStore.listActiveWithCredentialsSystem).not.toHaveBeenCalled()
  })

  it('401s a wrong secret', async () => {
    const { app } = buildApp('s3cret')
    const res = await request(app)
      .get('/internal/wechat/channels')
      .set('x-connector-secret', 'wrong')
    expect(res.status).toBe(401)
  })

  it('fails closed when the configured secret is empty — even an empty header loses', async () => {
    const { app, integrationStore } = buildApp('')
    const res = await request(app)
      .get('/internal/wechat/channels')
      .set('x-connector-secret', '')
    expect(res.status).toBe(401)
    expect(integrationStore.listActiveWithCredentialsSystem).not.toHaveBeenCalled()
  })

  it('serves the credential list to the correct secret', async () => {
    const { app } = buildApp('s3cret')
    const res = await request(app)
      .get('/internal/wechat/channels')
      .set('x-connector-secret', 's3cret')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      {
        channelId: 'chan-1',
        botToken: 'wechat-bot-token-1',
        baseUrl: 'https://shdx.ilink.example',
        getUpdatesBuf: 'cursor-abc',
      },
    ])
  })
})

describe('[COMP:api/wechat-inbound] cursor persistence', () => {
  it('merges the new get_updates_buf into the channel credentials', async () => {
    const { app, integrationStore } = buildApp('s3cret')
    const res = await request(app)
      .post('/internal/wechat/cursor')
      .set('x-connector-secret', 's3cret')
      .send({ channelId: 'chan-1', getUpdatesBuf: 'cursor-next' })
    expect(res.status).toBe(200)
    expect(integrationStore.mergeCredentialsSystem).toHaveBeenCalledTimes(1)
    const calls = integrationStore.mergeCredentialsSystem.mock.calls as unknown as Array<
      [string, string, (c: Record<string, unknown>) => Record<string, unknown>]
    >
    const [channelId, channelType, mutate] = calls[0]
    expect(channelId).toBe('chan-1')
    expect(channelType).toBe('wechat')
    expect(
      mutate({
        bot_token: 't',
        base_url: 'u',
        ilink_bot_id: 'b',
        get_updates_buf: 'old',
      }),
    ).toEqual({ bot_token: 't', base_url: 'u', ilink_bot_id: 'b', get_updates_buf: 'cursor-next' })
  })

  it('400s a payload without a cursor string', async () => {
    const { app } = buildApp('s3cret')
    const res = await request(app)
      .post('/internal/wechat/cursor')
      .set('x-connector-secret', 's3cret')
      .send({ channelId: 'chan-1' })
    expect(res.status).toBe(400)
  })
})
