import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexProviderManager } from '../../codex-provider-manager.js'
import { codexProviderRoutes } from '../codex-provider.js'

function manager(): CodexProviderManager {
  return {
    images: { inspect: vi.fn(), generate: vi.fn() },
    provider: {
      name: 'openai-codex',
      models: [],
      stream: vi.fn(),
      createSession: vi.fn(),
    },
    refresh: vi.fn(),
    status: vi.fn(async () => ({
      runtimeAvailable: true,
      account: {
        connected: true,
        authType: 'chatgpt' as const,
        planType: 'plus' as const,
        emailHint: 'o***@example.com',
        requiresOpenaiAuth: true,
      },
      models: [],
      preferredProvider: 'openai-codex' as const,
    })),
    startBrowserLogin: vi.fn(async () => ({
      type: 'chatgpt' as const,
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/oauth/authorize',
    })),
    startDeviceCodeLogin: vi.fn(async () => ({
      type: 'chatgptDeviceCode' as const,
      loginId: 'device-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })),
    cancelLogin: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    setPreferredProvider: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
}

function app(mgr: CodexProviderManager, enabled = true) {
  const result = express()
  result.use(express.json())
  result.use('/api/local/codex', codexProviderRoutes(mgr, () => enabled))
  return result
}

afterEach(() => vi.unstubAllEnvs())

describe('[COMP:api/codex-provider] local ChatGPT subscription routes', () => {
  it('returns only masked status and reviewed model state', async () => {
    const res = await request(app(manager())).get('/api/local/codex/status')
    expect(res.status).toBe(200)
    expect(res.body.account.emailHint).toBe('o***@example.com')
    expect(JSON.stringify(res.body)).not.toContain('owner@example.com')
  })

  it('starts browser and device-code login handoffs', async () => {
    const mgr = manager()
    const browser = await request(app(mgr)).post('/api/local/codex/login/browser')
    expect(browser.status).toBe(200)
    expect(browser.body).toEqual({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/oauth/authorize',
    })

    const device = await request(app(mgr)).post('/api/local/codex/login/device')
    expect(device.status).toBe(200)
    expect(device.body).toMatchObject({
      loginId: 'device-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
  })

  it('validates cancel ids and hides disabled provider routes', async () => {
    const mgr = manager()
    const invalid = await request(app(mgr)).post('/api/local/codex/login/cancel').send({})
    expect(invalid.status).toBe(400)
    expect(mgr.cancelLogin).not.toHaveBeenCalled()

    const hidden = await request(app(mgr, false)).get('/api/local/codex/status')
    expect(hidden.status).toBe(404)
  })

  it.each(['oss', 'outpost'])('supports the complete connection lifecycle in %s with the default capability gate', async (profile) => {
    vi.stubEnv('USEBRIAN_EDITION', profile)
    vi.stubEnv('K_SERVICE', '')
    const mgr = manager()
    const server = express()
    server.use(express.json())
    server.use('/api/local/codex', codexProviderRoutes(mgr))

    expect((await request(server).get('/api/local/codex/status')).status).toBe(200)
    expect((await request(server).post('/api/local/codex/login/browser')).status).toBe(200)
    expect((await request(server).post('/api/local/codex/login/device')).status).toBe(200)
    expect((await request(server).post('/api/local/codex/login/cancel').send({ loginId: 'login-1' })).status).toBe(200)
    expect((await request(server).put('/api/local/codex/preference').send({ preferredProvider: 'openai-codex' })).status).toBe(200)
    expect((await request(server).post('/api/local/codex/logout')).status).toBe(200)
    expect(mgr.status).toHaveBeenCalledOnce()
    expect(mgr.startBrowserLogin).toHaveBeenCalledOnce()
    expect(mgr.startDeviceCodeLogin).toHaveBeenCalledOnce()
    expect(mgr.cancelLogin).toHaveBeenCalledWith('login-1')
    expect(mgr.setPreferredProvider).toHaveBeenCalledWith('openai-codex')
    expect(mgr.logout).toHaveBeenCalledOnce()
  })

  it.each([
    ['hosted', ''],
    ['oss', 'brian-api'],
    ['outpost', 'brian-api'],
  ])('rejects every connection operation for edition=%s and K_SERVICE=%s', async (profile, cloudRun) => {
    vi.stubEnv('USEBRIAN_EDITION', profile)
    vi.stubEnv('K_SERVICE', cloudRun)
    const mgr = manager()
    const server = express()
    server.use(express.json())
    server.use('/api/local/codex', codexProviderRoutes(mgr))

    expect((await request(server).get('/api/local/codex/status')).status).toBe(404)
    for (const path of ['/login/browser', '/login/device', '/login/cancel', '/logout']) {
      expect((await request(server).post(`/api/local/codex${path}`).send({ loginId: 'login-1' })).status).toBe(404)
    }
    expect((await request(server).put('/api/local/codex/preference').send({ preferredProvider: 'openai-codex' })).status).toBe(404)
    expect(mgr.status).not.toHaveBeenCalled()
    expect(mgr.startBrowserLogin).not.toHaveBeenCalled()
    expect(mgr.startDeviceCodeLogin).not.toHaveBeenCalled()
    expect(mgr.cancelLogin).not.toHaveBeenCalled()
    expect(mgr.setPreferredProvider).not.toHaveBeenCalled()
    expect(mgr.logout).not.toHaveBeenCalled()
  })

  it('disconnects through app-server logout', async () => {
    const mgr = manager()
    const res = await request(app(mgr)).post('/api/local/codex/logout')
    expect(res.status).toBe(200)
    expect(mgr.logout).toHaveBeenCalledOnce()
  })

  it('validates and saves the preferred provider', async () => {
    const mgr = manager()
    const res = await request(app(mgr))
      .put('/api/local/codex/preference')
      .send({ preferredProvider: 'openai-codex' })
    expect(res.status).toBe(200)
    expect(mgr.setPreferredProvider).toHaveBeenCalledWith('openai-codex')

    const invalid = await request(app(mgr))
      .put('/api/local/codex/preference')
      .send({ preferredProvider: 'attacker-provider' })
    expect(invalid.status).toBe(400)
  })
})
